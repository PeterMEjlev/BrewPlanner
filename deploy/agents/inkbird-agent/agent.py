#!/usr/bin/env python3
"""
Inkbird ITC-308-WIFI agent for a satellite Raspberry Pi.

Polls the fermentation fridge/heater controller on the LAN and pushes its
readings to the BrewPlanner hub's ingestion API (POST /api/ingest), where they
show up on the dashboard and the device's history charts.

It is also the controller's *write* path: each cycle it pulls any setpoint
changes the operator queued from the dashboard (GET /api/commands), writes the
new target to the controller, then acks them (POST /api/commands/ack). Disable
this with BP_ALLOW_SETPOINT_WRITE=0 to keep the agent strictly read-only.

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
  BP_SIMULATE        If "1" (the default until you've paired the controller),
                     report synthetic values so the whole pipeline can be
                     verified before you have real credentials.
  BP_ALLOW_SETPOINT_WRITE
                     If "1" (the default), pull queued setpoint changes from the
                     hub and write them to the controller. Set "0" to stay
                     read-only (the dashboard control then has no effect).

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

INKBIRD_DEVICE_ID = os.environ.get("INKBIRD_DEVICE_ID", "")
INKBIRD_IP = os.environ.get("INKBIRD_IP", "")
INKBIRD_LOCAL_KEY = os.environ.get("INKBIRD_LOCAL_KEY", "")
INKBIRD_VERSION = float(os.environ.get("INKBIRD_VERSION", "3.4"))

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
    global _sim_setpoint
    target_c = max(SETPOINT_MIN_C, min(SETPOINT_MAX_C, target_c))

    if SIMULATE:
        _sim_setpoint = round(target_c, 1)
        log(f"[sim] applied setpoint -> {_sim_setpoint} C")
        return

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


def fetch_commands() -> list[dict]:
    """Pull this device's pending commands from the hub. Returns [] on any error."""
    req = urllib.request.Request(
        f"{HUB_URL}/api/commands",
        method="GET",
        headers={"Authorization": f"Bearer {DEVICE_KEY}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if not 200 <= resp.status < 300:
                return []
            data = json.loads(resp.read().decode("utf-8"))
            return data if isinstance(data, list) else []
    except urllib.error.HTTPError as e:
        log(f"command fetch rejected: HTTP {e.code} {e.reason}")
        return []
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
        log(f"command fetch failed (will retry): {e}")
        return []


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


def process_commands() -> int:
    """
    Pull, apply, and ack any commands queued for this device. A command that
    fails to apply is left un-acked so the hub re-offers it next cycle; an
    unrecognised command is acked (drained) so it can't wedge the queue.

    Returns the number of setpoint changes actually applied, so the caller can
    re-read the controller immediately and push the confirmed value — otherwise
    the dashboard's target keeps showing the old reading (taken at the top of
    this cycle) until the next read, ~one interval later.
    """
    applied: list[int] = []
    applied_setpoints = 0
    for cmd in fetch_commands():
        cmd_id = cmd.get("id")
        if not isinstance(cmd_id, int):
            continue
        kind = cmd.get("command")
        if kind == "set_setpoint":
            try:
                apply_setpoint(float(cmd["value"]))
                applied.append(cmd_id)
                applied_setpoints += 1
            except Exception as e:  # leave un-acked → retried next cycle
                log(f"failed to apply command {cmd_id} ({kind}): {e}")
        else:
            log(f"draining unknown command {kind!r} (id {cmd_id})")
            applied.append(cmd_id)
    ack_commands(applied)
    return applied_setpoints


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


def _stop(_signum, _frame) -> None:
    global _running
    _running = False
    log("shutting down")


def main() -> int:
    if not DEVICE_KEY:
        log("DEVICE_KEY is not set — refusing to start. See inkbird-agent.service.")
        return 1

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    log(
        f"starting: hub={HUB_URL} interval={INTERVAL}s simulate={SIMULATE} "
        f"writes={ALLOW_SETPOINT_WRITE} target={INKBIRD_IP or '(unset)'}"
    )

    buffer: deque[dict] = deque(maxlen=MAX_BUFFER)
    # The hub hands back the operator-set logging cadence on each push; start
    # from the env default until the first successful push tells us otherwise.
    interval = INTERVAL

    while _running:
        cycle_start = time.monotonic()
        collect_reading(buffer)
        interval = flush_buffer(buffer, interval)

        # Apply any setpoint changes the operator queued from the dashboard. When
        # one is applied, re-read and push straight away so the controller's new
        # setpoint reaches the hub this cycle — otherwise the dashboard target
        # keeps showing the pre-change reading until the next read (~one interval
        # later). A flaky controller/network here must never kill the agent.
        if ALLOW_SETPOINT_WRITE:
            try:
                if process_commands() > 0:
                    time.sleep(1.0)  # let the controller settle after the write
                    collect_reading(buffer)
                    interval = flush_buffer(buffer, interval)
            except Exception as e:
                log(f"command processing failed (will retry): {e}")

        # Sleep the remainder of the interval, waking early on shutdown.
        elapsed = time.monotonic() - cycle_start
        remaining = max(0.0, interval - elapsed)
        while _running and remaining > 0:
            step = min(1.0, remaining)
            time.sleep(step)
            remaining -= step

    return 0


if __name__ == "__main__":
    sys.exit(main())
