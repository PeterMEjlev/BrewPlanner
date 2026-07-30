#!/usr/bin/env python3
"""
Inkbird ITC-308-WIFI agent for a satellite Raspberry Pi.

Polls the fermentation fridge/heater controller on the LAN and pushes its
readings to the BrewPlanner hub's ingestion API (POST /api/ingest), where they
show up on the dashboard and the device's history charts.

It is also the controller's *write* path: it pulls any setpoint changes the
operator queued from the dashboard (GET /api/commands), writes the new target to
the controller, then acks them (POST /api/commands/ack). Disable this with
BP_ALLOW_SETPOINT_WRITE=0 to keep the agent strictly read-only.

Writes are decoupled from the read cadence. Reads stay on their wall-clock
schedule, but the gap between them isn't spent idle: the agent parks on
`GET /api/commands?wait=N`, which the hub holds open until a command is queued
for this device. Tapping Apply on the dashboard therefore reaches the hardware in
about a round-trip rather than waiting out the logging interval — five minutes on
the brewery controllers. The per-cycle command check is kept as a safety net, so
an older hub (or one that was restarting when the change was queued) still gets
the change applied on the next read.

The ITC-308-WIFI is a Tuya device under the hood, so we read it locally with
`tinytuya` (no cloud round-trip). It exposes:
  - current temperature        (Tuya DPS 104, value is degrees x10)
  - target setpoint            (Tuya DPS 106, value is degrees x10)
  - HVAC action / relay state  (Tuya DPS 115: 1=cooling, 3=heating, 0/2=idle)
  - temperature unit C/F       (Tuya DPS 101; when "F", current temp is DPS 116)

We report three metrics so the dashboard gets a temp chart, the setpoint line,
and the controller's current relay mode (it drives only one relay at a time):
  temp_c, setpoint_c, hvac_state (-1 cooling, 0 idle, +1 heating)

Configuration (all via environment, see inkbird-agent.service):
  HUB_URL            Base URL of the hub, e.g. http://checklist01.local:3000
  DEVICE_KEY         The hub device key from `npm run device -- add ...`
  INTERVAL           Seconds between reads (default: 30 — see the note below)
  INKBIRD_DEVICE_ID  Tuya device id    (from the tinytuya wizard, see README)
  INKBIRD_IP         Controller's LAN IP (from the wizard / your router)
  INKBIRD_LOCAL_KEY  Tuya local key    (from the wizard)
  INKBIRD_VERSION    Tuya protocol version (default: 3.4)
  INKBIRD_NAME       What this controller is called in the Inkbird/Tuya app, shown
                     on the hub's Devices page. Optional: left unset, the agent
                     looks the name up by INKBIRD_DEVICE_ID in the tinytuya
                     wizard's devices.json (see INKBIRD_DEVICES_JSON).
  INKBIRD_DEVICES_JSON
                     Path to that wizard output. Unset, the agent looks beside
                     itself and then in ~/devices.json.
  BP_SIMULATE        If "1" (the default until you've paired the controller),
                     report synthetic values so the whole pipeline can be
                     verified before you have real credentials.
  BP_ALLOW_SETPOINT_WRITE
                     If "1" (the default), pull queued setpoint changes from the
                     hub and write them to the controller. Set "0" to stay
                     read-only (the dashboard control then has no effect).
  BP_COMMAND_WAIT    Seconds the hub may hold a command poll open (default: 25,
                     0 disables long-polling). This is not the write latency —
                     a parked poll answers as soon as a command is queued — only
                     how often an idle agent re-parks.

Reliability note: the ITC-308-WIFI is known to drop frequent pollers with an
"Err 914" after a while if a socket is held open. We therefore open a fresh,
non-persistent connection each cycle and poll gently (default 30s). A failed
read never kills the agent; on a network blip the readings are buffered in
memory and flushed on the next successful push.
"""

from __future__ import annotations

import json
import math
import os
import signal
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections import deque
from datetime import datetime, timezone

HUB_URL = os.environ.get("HUB_URL", "http://localhost:3000").rstrip("/")
DEVICE_KEY = os.environ.get("DEVICE_KEY", "")
INTERVAL = float(os.environ.get("INTERVAL", "30"))
SIMULATE = os.environ.get("BP_SIMULATE", "1") == "1"
ALLOW_SETPOINT_WRITE = os.environ.get("BP_ALLOW_SETPOINT_WRITE", "1") == "1"

# Seconds the hub may hold a command poll open. This does NOT bound how long a
# setpoint takes to land — the hub answers a parked poll the instant a command is
# queued — it only sets how often an idle agent re-parks. Kept under the 60s idle
# timeout common to proxies and keep-alive handling, and within the hub's own cap
# (COMMAND_POLL_WAIT_SEC). 0 disables long-polling: commands are then only picked
# up on the read cycle, as before.
COMMAND_WAIT = float(os.environ.get("BP_COMMAND_WAIT", "25"))
# Ordinary HTTP call budget, and the margin allowed on top of a long-poll's hold.
HTTP_TIMEOUT = 10.0
# Pause before re-parking after a failed poll, so an unreachable hub is retried
# steadily rather than in a tight loop.
HUB_RETRY_SEC = 10.0
# Never write to the controller more often than this. Event-driven writes can
# arrive back to back (a few quick taps of Apply) and the ITC-308-WIFI does not
# like being hammered — see the reliability note in the module docstring.
MIN_WRITE_GAP_SEC = 3.0

INKBIRD_DEVICE_ID = os.environ.get("INKBIRD_DEVICE_ID", "")
INKBIRD_IP = os.environ.get("INKBIRD_IP", "")
INKBIRD_LOCAL_KEY = os.environ.get("INKBIRD_LOCAL_KEY", "")
INKBIRD_VERSION = float(os.environ.get("INKBIRD_VERSION", "3.4"))
INKBIRD_NAME = os.environ.get("INKBIRD_NAME", "").strip()
INKBIRD_DEVICES_JSON = os.environ.get("INKBIRD_DEVICES_JSON", "").strip()

# Where to look for the tinytuya wizard's output when INKBIRD_DEVICES_JSON is
# unset, in order: next to this agent, then the home directory the wizard is
# normally run from. The unit file sets no WorkingDirectory (so a bare relative
# path would resolve against `/`), hence the explicit candidates.
DEVICES_JSON_CANDIDATES = (
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "devices.json"),
    os.path.expanduser("~/devices.json"),
)

# Defensive bounds for a setpoint written to the hardware (mirrors the hub's
# validation): even if a bad value slips through, never command something wild.
SETPOINT_MIN_C = -10.0
SETPOINT_MAX_C = 50.0

# The simulated controller's current target; updated when a setpoint command is
# "applied" in BP_SIMULATE mode so the end-to-end change is visible on the hub.
_sim_setpoint = 18.0

# Tuya DPS (data point) ids on the ITC-308-WIFI.
DP_UNIT = "101"          # "C" | "F"
DP_TEMP_C = "104"        # current temperature, x10 (used when unit is C)
DP_SETPOINT = "106"      # target temperature, x10 (in the device's unit)
DP_HVAC_ACTION = "115"   # "0"/"2" idle, "1" cooling, "3" heating
DP_TEMP_F = "116"        # current temperature, x10 (used when unit is F)

# Cap the backlog so a long outage can't grow memory without bound. Each cycle
# pushes 4 metrics; 2880 samples is ~12h at one cycle every 30s.
MAX_BUFFER = 2880

_running = True
# True while blocked in a long-poll, so shutdown knows it has to interrupt one.
_in_long_poll = False
# When the controller was last written to, for the MIN_WRITE_GAP_SEC floor.
_last_write_at = 0.0
# Cleared if the hub turns out not to support long-polling (an older hub answers
# `?wait=N` immediately), after which the agent falls back to plain sleeping.
_long_poll = COMMAND_WAIT > 0


class _Shutdown(BaseException):
    """
    Raised out of a parked long-poll when a signal arrives.

    Deliberately a BaseException: it unwinds through the `except Exception`
    handlers that keep a flaky controller or network from killing the agent,
    which must not swallow a shutdown. Only main() catches it.
    """


def utc_now_iso() -> str:
    """UTC timestamp like JS `toISOString()`: millisecond precision, `Z` suffix."""
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def log(msg: str) -> None:
    """Line-buffered stdout so journald captures messages promptly."""
    print(f"[inkbird-agent] {msg}", flush=True)


def f_to_c(f: float) -> float:
    return (f - 32.0) * 5.0 / 9.0


def c_to_f(c: float) -> float:
    return c * 9.0 / 5.0 + 32.0


def connect():
    """
    Open a fresh, non-persistent tinytuya connection to the controller. Shared by
    the read and write paths; non-persistent sockets avoid the ITC-308-WIFI
    "Err 914" lock-up (see the module docstring).
    """
    import tinytuya  # imported lazily so SIMULATE mode needs no pip install

    if not (INKBIRD_DEVICE_ID and INKBIRD_IP and INKBIRD_LOCAL_KEY):
        raise RuntimeError(
            "INKBIRD_DEVICE_ID, INKBIRD_IP and INKBIRD_LOCAL_KEY must all be set "
            "for live reads/writes. Run the tinytuya wizard (see README) or set "
            "BP_SIMULATE=1 to test the pipeline."
        )
    dev = tinytuya.OutletDevice(INKBIRD_DEVICE_ID, INKBIRD_IP, INKBIRD_LOCAL_KEY)
    dev.set_version(INKBIRD_VERSION)
    dev.set_socketPersistent(False)
    dev.set_socketTimeout(5)
    # A transiently-unreachable ITC-308-WIFI must fail *fast*. By default tinytuya
    # retries the connection several times (socketRetryLimit=5, socketRetryDelay=5),
    # so a single bad read can block this single-threaded loop for tens of seconds
    # — long enough to skip several cycles and flap the dashboard tile Offline even
    # though the controller is basically fine. Cap it to one quick retry: a dropped
    # poll is given up on in ~10s and simply retried next cycle, and the hub now
    # tolerates a few missed reads before showing Offline (DEVICE_ONLINE_MISS_CYCLES).
    dev.set_socketRetryLimit(2)
    dev.set_socketRetryDelay(1)
    return dev


def read_inkbird() -> dict[str, float]:
    """
    Return the controller's current metrics as a dict of metric -> value.

    Keys: temp_c, setpoint_c, hvac_state (-1 cooling, 0 idle, +1 heating).

    Until the controller is paired and BP_SIMULATE is set to 0, this returns a
    synthetic fermentation-like curve so the agent -> hub -> dashboard pipeline
    can be verified end to end.
    """
    if SIMULATE:
        # The temperature drifts +/-0.6C around the (mutable) setpoint on a
        # ~20-minute cycle; the relays mimic a real hysteresis controller. The
        # setpoint follows any applied set_setpoint command (see apply_setpoint).
        setpoint = _sim_setpoint
        temp = round(setpoint + 0.6 * math.sin(time.time() / 1200.0), 2)
        if temp > setpoint + 0.3:
            hvac = -1.0  # cooling
        elif temp < setpoint - 0.3:
            hvac = 1.0  # heating
        else:
            hvac = 0.0  # idle
        return {"temp_c": temp, "setpoint_c": setpoint, "hvac_state": hvac}

    # Fresh, non-persistent connection each cycle — see the reliability note in
    # the module docstring (avoids the ITC-308-WIFI "Err 914" lock-up).
    dev = connect()
    status = dev.status()
    if not isinstance(status, dict) or "dps" not in status:
        raise RuntimeError(f"unexpected status from controller: {status!r}")
    dps = status["dps"]

    in_fahrenheit = str(dps.get(DP_UNIT, "C")).upper().startswith("F")

    # Current temperature: DPS 104 in C, DPS 116 in F; both reported x10.
    raw_temp = dps.get(DP_TEMP_F if in_fahrenheit else DP_TEMP_C)
    if raw_temp is None:
        raise RuntimeError(f"no current-temperature DPS in status: {dps!r}")
    temp = raw_temp / 10.0
    if in_fahrenheit:
        temp = f_to_c(temp)

    # Setpoint (DPS 106) is reported x10 in the device's configured unit.
    raw_setpoint = dps.get(DP_SETPOINT)
    setpoint = None
    if raw_setpoint is not None:
        setpoint = raw_setpoint / 10.0
        if in_fahrenheit:
            setpoint = f_to_c(setpoint)

    # DPS 115: "1"=cooling, "3"=heating, "0"/"2"=idle. The controller drives one
    # relay at a time, so report it as a single signed state — charts intuitively
    # (cooling pulls the temp down, heating pushes it up).
    action = str(dps.get(DP_HVAC_ACTION, "0"))
    hvac = -1.0 if action == "1" else 1.0 if action == "3" else 0.0
    metrics: dict[str, float] = {"temp_c": round(temp, 2), "hvac_state": hvac}
    if setpoint is not None:
        metrics["setpoint_c"] = round(setpoint, 2)
    return metrics


def host_mac() -> str | None:
    """
    Best-effort MAC of this host's primary interface (the link-layer address
    never survives the trip over IP). Used only as the SIMULATE-mode identity —
    live pushes report the *controller's* MAC instead (see device_identity),
    since several controllers can share one satellite host. Returns None when only
    a random/locally-administered address is available — uuid.getnode()'s fallback
    when it can't find real hardware — so the hub leaves the field blank rather
    than storing a meaningless value. Computed once into HOST_MAC below; it
    doesn't change at runtime.
    """
    node = uuid.getnode()
    # getnode() sets the multicast bit (the low bit of the first octet) only when
    # it had to invent a random address; a real NIC MAC never has it set.
    if (node >> 40) & 0x01:
        return None
    return ":".join(f"{(node >> shift) & 0xFF:02x}" for shift in range(40, -8, -8))


HOST_MAC = host_mac()


def controller_mac() -> str | None:
    """
    Best-effort MAC of the Inkbird controller itself (INKBIRD_IP), read from the
    host's ARP neighbour table (/proc/net/arp on Linux). The controller is a
    *separate* Tuya device on the LAN, so its hardware address — not the pushing
    satellite's — is what the Devices page should show. The entry is normally
    present because the poll we do each cycle talks to INKBIRD_IP over TCP, which
    populates the cache. Returns None when it can't be resolved (controller not on
    the same L2 segment, not yet cached, or a non-Linux host), so the hub keeps
    the last value rather than storing a wrong one.
    """
    if not INKBIRD_IP:
        return None
    try:
        with open("/proc/net/arp", encoding="ascii") as fh:
            next(fh, None)  # skip the header row
            for line in fh:
                fields = line.split()
                # columns: IP address, HW type, Flags, HW address, Mask, Device
                if len(fields) >= 4 and fields[0] == INKBIRD_IP:
                    mac = fields[3].lower()
                    if mac and mac != "00:00:00:00:00:00":
                        return mac
    except OSError:
        pass
    return None


def vendor_name() -> str | None:
    """
    What this controller is called in the Inkbird/Tuya app, reported so the hub's
    Devices page can show which physical box a card is (it never replaces the name
    the device is registered under on the hub).

    The name is an account-side attribute: the Tuya local protocol serves only
    data points, so no LAN read can ever see it. But the tinytuya wizard already
    captured it when it fetched the device id and local key, so we read it back
    from that same devices.json instead of calling the cloud every cycle.

    INKBIRD_NAME wins when set — for a host without the wizard output, or when the
    app name isn't what you want on the dashboard. Returns None when neither is
    available, and the hub then keeps whatever it last stored.
    """
    if INKBIRD_NAME:
        return INKBIRD_NAME
    if not INKBIRD_DEVICE_ID:
        return None
    paths = [INKBIRD_DEVICES_JSON] if INKBIRD_DEVICES_JSON else DEVICES_JSON_CANDIDATES
    for path in paths:
        try:
            with open(path, encoding="utf-8") as fh:
                entries = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if isinstance(entry, dict) and entry.get("id") == INKBIRD_DEVICE_ID:
                name = entry.get("name")
                if isinstance(name, str) and name.strip():
                    return name.strip()
    return None


# Resolved once at startup: neither the env var nor the wizard's file changes
# while the agent runs, so renaming the controller in the app takes a restart.
VENDOR_NAME = vendor_name()


def device_identity() -> tuple[str | None, str | None]:
    """
    (mac, ip) describing the *controlled device* to report on each push, so the
    Devices page identifies the Inkbird controller rather than this satellite
    host. Live: the controller's ARP-resolved MAC and its configured LAN IP.
    SIMULATE (no real controller): the host's own MAC and no IP, matching the
    pre-existing behaviour. A None MAC is simply omitted from the push (the hub
    keeps whatever it last stored) rather than falling back to the host's —
    reporting the shared host MAC is exactly the mix-up we're avoiding, since
    several controllers on one satellite would then all show the same address.
    """
    if not SIMULATE and INKBIRD_IP:
        return controller_mac(), INKBIRD_IP
    return HOST_MAC, None


def push(samples: list[dict], current_interval: float) -> float | None:
    """
    POST a batch of readings. On success, return the hub's advised logging
    interval in seconds — the per-device cadence the operator sets from the
    dashboard — so the agent can match its push rate to it; falls back to
    current_interval when the response omits one. Returns None on failure so the
    caller keeps the backlog for the next attempt.
    """
    payload: dict = {"readings": samples}
    mac, ip = device_identity()
    if mac:
        payload["mac"] = mac
    if ip:
        payload["ip"] = ip
    if VENDOR_NAME:
        payload["vendorName"] = VENDOR_NAME
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{HUB_URL}/api/ingest",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {DEVICE_KEY}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if not 200 <= resp.status < 300:
                return None
            try:
                advised = json.loads(resp.read().decode("utf-8")).get("intervalSec")
            except (ValueError, OSError):
                advised = None
            if isinstance(advised, (int, float)) and advised > 0:
                return float(advised)
            return current_interval
    except urllib.error.HTTPError as e:
        # 401 means a bad/empty key — log loudly; retrying won't help.
        log(f"push rejected: HTTP {e.code} {e.reason}")
        return None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        log(f"push failed (will retry): {e}")
        return None


def apply_setpoint(target_c: float) -> None:
    """
    Write a new target temperature to the controller (DPS 106, degrees x10 in
    the device's own unit). In SIMULATE mode we just move the simulated setpoint
    so the change shows up on the hub. Raises on failure so the caller can leave
    the command un-acked for a retry next cycle.
    """
    global _sim_setpoint, _last_write_at
    target_c = max(SETPOINT_MIN_C, min(SETPOINT_MAX_C, target_c))

    if SIMULATE:
        _sim_setpoint = round(target_c, 1)
        log(f"[sim] applied setpoint -> {_sim_setpoint} C")
        return

    # Writes are event-driven, so two can land seconds apart if the operator taps
    # Apply a few times. Space them out before touching the controller.
    gap = MIN_WRITE_GAP_SEC - (time.time() - _last_write_at)
    if gap > 0:
        time.sleep(gap)
    _last_write_at = time.time()

    dev = connect()
    status = dev.status()
    dps = status.get("dps", {}) if isinstance(status, dict) else {}
    in_fahrenheit = str(dps.get(DP_UNIT, "C")).upper().startswith("F")

    target_in_device_unit = c_to_f(target_c) if in_fahrenheit else target_c
    raw = int(round(target_in_device_unit * 10))
    result = dev.set_value(DP_SETPOINT, raw)
    if isinstance(result, dict) and result.get("Error"):
        raise RuntimeError(f"controller rejected setpoint write: {result!r}")
    log(f"applied setpoint -> {target_c} C (DPS {DP_SETPOINT}={raw})")


def fetch_commands(wait_sec: float = 0.0) -> list[dict] | None:
    """
    Pull this device's pending commands from the hub.

    With `wait_sec` above zero the hub is asked to hold the request open until a
    command is queued for this device, answering early the moment one is — that
    long-poll is what makes a dashboard setpoint change reach the controller
    straight away instead of on the next read cycle.

    Returns the (possibly empty) command list, or None when the hub couldn't be
    reached: the caller has to tell "nothing queued" from "no hub" so it can back
    off instead of reconnecting in a tight loop.
    """
    global _in_long_poll

    url = f"{HUB_URL}/api/commands"
    if wait_sec > 0:
        url += f"?wait={int(wait_sec)}"
    req = urllib.request.Request(
        url,
        method="GET",
        headers={"Authorization": f"Bearer {DEVICE_KEY}"},
    )
    try:
        _in_long_poll = wait_sec > 0
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT + wait_sec) as resp:
            if not 200 <= resp.status < 300:
                return None
            data = json.loads(resp.read().decode("utf-8"))
            return data if isinstance(data, list) else []
    except urllib.error.HTTPError as e:
        log(f"command fetch rejected: HTTP {e.code} {e.reason}")
        return None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        log(f"command fetch failed (will retry): {e}")
        return None
    finally:
        _in_long_poll = False


def ack_commands(ids: list[int]) -> None:
    """Tell the hub which commands have been applied so it clears them."""
    if not ids:
        return
    body = json.dumps({"ids": ids}).encode("utf-8")
    req = urllib.request.Request(
        f"{HUB_URL}/api/commands/ack",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {DEVICE_KEY}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if not 200 <= resp.status < 300:
                log(f"command ack rejected: HTTP {resp.status}")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as e:
        log(f"command ack failed (will retry): {e}")


def apply_commands(commands: list[dict]) -> int:
    """
    Apply a batch of commands and ack them. A command that fails to apply is left
    un-acked so the hub re-offers it next time; an unrecognised command is acked
    (drained) so it can't wedge the queue.

    Returns the number of setpoint changes actually applied, so the caller can
    re-read the controller immediately and push the confirmed value — otherwise
    the dashboard's target keeps showing the reading taken before the write until
    the next one, up to a whole interval later.
    """
    applied: list[int] = []
    applied_setpoints = 0
    for cmd in commands:
        cmd_id = cmd.get("id")
        if not isinstance(cmd_id, int):
            continue
        kind = cmd.get("command")
        if kind == "set_setpoint":
            try:
                apply_setpoint(float(cmd["value"]))
                applied.append(cmd_id)
                applied_setpoints += 1
            except Exception as e:  # leave un-acked → retried next time
                log(f"failed to apply command {cmd_id} ({kind}): {e}")
        else:
            log(f"draining unknown command {kind!r} (id {cmd_id})")
            applied.append(cmd_id)
    ack_commands(applied)
    return applied_setpoints


def process_commands() -> int:
    """
    Apply whatever is queued for this device right now, without waiting. Used at
    the top of each read cycle as the safety net behind the long-poll: it catches
    anything queued while the agent wasn't parked (hub restart, network blip, an
    older hub with no long-poll support).
    """
    return apply_commands(fetch_commands() or [])


def collect_reading(buffer: deque[dict]) -> None:
    """
    Read the controller once and append its metrics to the send buffer. A flaky
    controller/network must never kill the agent, so a failed read is logged and
    left for the next attempt rather than raised.
    """
    try:
        now = utc_now_iso()
        for metric, value in read_inkbird().items():
            buffer.append({"metric": metric, "value": value, "recordedAt": now})
    except Exception as e:
        log(f"read failed (will retry): {e}")


def flush_buffer(buffer: deque[dict], interval: float) -> float:
    """
    Push the whole backlog at once, keeping it on failure. A successful push
    echoes the hub's current per-device logging interval — adopt it so a change
    made from the dashboard takes effect without a redeploy. Returns the interval
    to use for the next cycle (unchanged on an empty buffer or a failed push).
    """
    if not buffer:
        return interval
    advised = push(list(buffer), interval)
    if advised is not None:
        buffer.clear()
        if advised != interval:
            log(f"hub set logging interval to {advised:g}s")
            interval = advised
    return interval


def next_slot(interval: float) -> float:
    """
    Wall-clock time of the next logging slot: the next whole multiple of
    `interval` past local midnight. Sleeping to that rather than "one interval
    on from wherever this cycle finished" is what puts a 5-minute cadence on
    09:30:00, 09:35:00 ... instead of on whatever second the agent happened to
    start at — the hub's charts get readable, evenly-spaced samples, and two
    agents on the same cadence line up with each other.

    Midnight is the anchor, not the epoch, so the slots match the clock on the
    wall in any time zone; an interval that doesn't divide the day evenly just
    gets a short last slot before midnight.
    """
    now = time.time()
    if interval <= 0:
        return now
    offset = time.localtime(now).tm_gmtoff or 0
    local = now + offset
    midnight = local - (local % 86400.0)
    slots = math.floor((local - midnight) / interval) + 1
    return midnight + slots * interval - offset


def sleep_until(deadline: float) -> None:
    """
    Sleep to a wall-clock deadline, in steps of at most a second so a SIGTERM
    still lands promptly. Re-read each step rather than counted down, so a clock
    correction (NTP on a Pi with no RTC) can't leave us sleeping past the slot.
    """
    while _running:
        remaining = deadline - time.time()
        if remaining <= 0:
            return
        time.sleep(min(1.0, remaining))


def wait_for_slot(deadline: float, buffer: deque[dict], interval: float) -> float:
    """
    Wait out the gap to the next read slot, applying setpoint changes the moment
    the hub reports one instead of sitting idle until the next read.

    The hub holds `GET /api/commands?wait=N` open until this device has something
    queued, so the agent spends the gap parked on a connection that answers within
    a round-trip of the operator tapping Apply. Reads stay on their wall-clock
    grid either way — only the write path is decoupled from it.

    An applied write is followed by a re-read and push so the dashboard confirms
    the new target straight away. That sample lands off-grid, which is the
    intended trade: the alternative is "Setting to N°C…" sitting on screen for
    the rest of the interval.

    Degrades to plain sleeping whenever long-polling isn't available — disabled by
    config, writes turned off, or a hub too old to understand `wait`. Returns the
    logging interval to use next, which a mid-wait push may have changed.
    """
    global _long_poll

    while _running:
        remaining = deadline - time.time()
        if remaining <= 0:
            break

        # Nothing to park for, or too little of the gap left to be worth it.
        if not (_long_poll and ALLOW_SETPOINT_WRITE) or remaining < 1.0:
            time.sleep(min(1.0, remaining))
            continue

        wait = min(COMMAND_WAIT, remaining)
        started = time.time()
        commands = fetch_commands(wait)

        if commands is None:  # hub unreachable — back off rather than spin on it
            sleep_until(min(deadline, time.time() + HUB_RETRY_SEC))
            continue

        if not commands:
            # A hub that predates long-polling ignores `wait` and answers at once;
            # parking against one would busy-loop it. Notice the too-fast empty
            # answer and drop back to sleeping for the rest of this process's life
            # (a restart re-probes, so an upgraded hub is picked up on deploy).
            if time.time() - started < wait / 2:
                log("hub does not support command long-poll — falling back to per-cycle checks")
                _long_poll = False
            continue

        if apply_commands(commands) > 0:
            time.sleep(1.0)  # let the controller settle after the write
            collect_reading(buffer)
            flushed = flush_buffer(buffer, interval)
            # A cadence change from the dashboard moves the grid under us.
            if flushed != interval:
                interval = flushed
                deadline = next_slot(interval)

    return interval


def _stop(_signum, _frame) -> None:
    global _running
    _running = False
    log("shutting down")
    # A parked long-poll is blocked in a socket read, and Python retries a
    # signal-interrupted syscall (PEP 475) — so without this the agent would sit
    # there until the hold expired, holding up every deploy's restart.
    if _in_long_poll:
        raise _Shutdown


def main() -> int:
    if not DEVICE_KEY:
        log("DEVICE_KEY is not set — refusing to start. See inkbird-agent.service.")
        return 1

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    log(
        f"starting: hub={HUB_URL} interval={INTERVAL}s simulate={SIMULATE} "
        f"writes={ALLOW_SETPOINT_WRITE} command_wait={COMMAND_WAIT:g}s "
        f"target={INKBIRD_IP or '(unset)'} name={VENDOR_NAME or '(unknown)'}"
    )

    buffer: deque[dict] = deque(maxlen=MAX_BUFFER)
    # The hub hands back the operator-set logging cadence on each push; start
    # from the env default until the first successful push tells us otherwise.
    interval = INTERVAL

    try:
        while _running:
            collect_reading(buffer)
            interval = flush_buffer(buffer, interval)

            # Catch anything queued while the agent wasn't parked on the hub —
            # a hub restart, a network blip, a hub with no long-poll support. On
            # a healthy pair this normally finds nothing, because the change was
            # already applied the moment it was queued (see wait_for_slot). When
            # one is applied, re-read and push straight away so the controller's
            # new setpoint reaches the hub now rather than an interval later. A
            # flaky controller/network here must never kill the agent.
            if ALLOW_SETPOINT_WRITE:
                try:
                    if process_commands() > 0:
                        time.sleep(1.0)  # let the controller settle after the write
                        collect_reading(buffer)
                        interval = flush_buffer(buffer, interval)
                except Exception as e:
                    log(f"command processing failed (will retry): {e}")

            # Wait out the gap to the next round wall-clock slot, applying any
            # setpoint change the moment the hub reports one, and waking early on
            # shutdown.
            interval = wait_for_slot(next_slot(interval), buffer, interval)
    except _Shutdown:
        pass  # signalled out of a parked long-poll; _stop already logged it

    return 0


if __name__ == "__main__":
    sys.exit(main())
