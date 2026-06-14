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


def push(samples: list[dict]) -> bool:
    """POST a batch of readings. Returns True on success (HTTP 2xx)."""
    body = json.dumps({"readings": samples}).encode("utf-8")
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
            return 200 <= resp.status < 300
    except urllib.error.HTTPError as e:
        # 401 means a bad/empty key — log loudly; retrying won't help.
        log(f"push rejected: HTTP {e.code} {e.reason}")
        return False
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        log(f"push failed (will retry): {e}")
        return False


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


def process_commands() -> None:
    """
    Pull, apply, and ack any commands queued for this device. A command that
    fails to apply is left un-acked so the hub re-offers it next cycle; an
    unrecognised command is acked (drained) so it can't wedge the queue.
    """
    applied: list[int] = []
    for cmd in fetch_commands():
        cmd_id = cmd.get("id")
        if not isinstance(cmd_id, int):
            continue
        kind = cmd.get("command")
        if kind == "set_setpoint":
            try:
                apply_setpoint(float(cmd["value"]))
                applied.append(cmd_id)
            except Exception as e:  # leave un-acked → retried next cycle
                log(f"failed to apply command {cmd_id} ({kind}): {e}")
        else:
            log(f"draining unknown command {kind!r} (id {cmd_id})")
            applied.append(cmd_id)
    ack_commands(applied)


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

    while _running:
        cycle_start = time.monotonic()
        try:
            now = utc_now_iso()
            for metric, value in read_inkbird().items():
                buffer.append({"metric": metric, "value": value, "recordedAt": now})
        except Exception as e:  # a flaky controller/network shouldn't kill the agent
            log(f"read failed (will retry): {e}")

        # Try to flush the whole backlog at once; keep it on failure.
        if buffer and push(list(buffer)):
            buffer.clear()

        # Apply any setpoint changes the operator queued from the dashboard. A
        # flaky controller/network here must never kill the agent either.
        if ALLOW_SETPOINT_WRITE:
            try:
                process_commands()
            except Exception as e:
                log(f"command processing failed (will retry): {e}")

        # Sleep the remainder of the interval, waking early on shutdown.
        elapsed = time.monotonic() - cycle_start
        remaining = max(0.0, INTERVAL - elapsed)
        while _running and remaining > 0:
            step = min(1.0, remaining)
            time.sleep(step)
            remaining -= step

    return 0


if __name__ == "__main__":
    sys.exit(main())
