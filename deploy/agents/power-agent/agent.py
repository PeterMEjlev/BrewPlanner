#!/usr/bin/env python3
"""
Electricity (power + energy) agent for a satellite Raspberry Pi.

Reads the brewery's mains usage on an interval and pushes it to the BrewPlanner
hub's ingestion API (POST /api/ingest), where it shows up on the dashboard and
the device's history charts. Reports two metrics:

  power_w     instantaneous draw in watts
  energy_kwh  cumulative energy in kWh (a meter-style running total)

Uses only the Python standard library in simulate mode, so the Pi needs no pip
install until you wire a real meter (see read_power() for worked examples).

Configuration (all via environment, see power-agent.service):
  HUB_URL      Base URL of the hub, e.g. http://checklist01.local:3000
  DEVICE_KEY   The device key printed by `npm run device -- add ...` on the hub
  INTERVAL     Seconds between reads (default: 30)
  BP_SIMULATE  If "1" (the default until you wire a real meter), report a
               synthetic value so you can verify the whole pipeline first.

On a network blip the readings are buffered in memory and flushed on the next
successful push, so a brief hub reboot doesn't lose data.
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

# Cap the backlog so a long outage can't grow memory without bound. Each cycle
# pushes 2 metrics; 5760 samples is ~24h at one cycle every 30s.
MAX_BUFFER = 5760

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
    print(f"[power-agent] {msg}", flush=True)


def read_power() -> dict[str, float]:
    """
    Return the current electricity metrics as a dict of metric -> value.

    Keys: power_w (instantaneous watts), energy_kwh (cumulative kWh).

    >>> TODO: replace the simulate branch's fallback with your real meter. <<<

    Common ways to get these on a Pi:
      - A smart plug / clamp that speaks Tuya locally (like the Inkbird agent):
            import tinytuya
            dev = tinytuya.OutletDevice(ID, IP, KEY); dev.set_version(3.4)
            dps = dev.status()["dps"]
            return {"power_w": dps["19"] / 10.0, "energy_kwh": dps["17"] / 100.0}
        (DPS ids vary by model — confirm with `python3 -m tinytuya wizard`.)
      - A Shelly EM / Plus PM over HTTP on the LAN:
            import urllib.request
            s = json.load(urllib.request.urlopen(f"http://{SHELLY_IP}/status"))
            em = s["emeters"][0]
            return {"power_w": em["power"], "energy_kwh": em["total"] / 1000.0}
      - A CT clamp on an ADS1115 ADC with emonlib-style RMS maths.

    Until then, BP_SIMULATE=1 produces a gently varying synthetic curve so the
    end-to-end pipeline (agent -> hub -> dashboard chart) can be verified.
    """
    if SIMULATE:
        # A smooth 20-380 W draw (fridge + the odd pump) on a ~15-minute wave.
        now = time.time()
        power_w = round(200 + 180 * math.sin(now / 450.0), 1)
        # Cumulative energy used so far *today* (UTC), as a meter-style total.
        # Anchored to midnight so it climbs steadily and is restart-stable.
        midnight = (
            datetime.now(timezone.utc)
            .replace(hour=0, minute=0, second=0, microsecond=0)
            .timestamp()
        )
        hours_today = max(0.0, (now - midnight) / 3600.0)
        energy_kwh = round(0.2 * hours_today, 3)  # ~0.2 kW average draw
        return {"power_w": power_w, "energy_kwh": energy_kwh}
    raise NotImplementedError(
        "read_power() is not implemented. Wire your meter here, or set "
        "BP_SIMULATE=1 to test the pipeline with synthetic data."
    )


def push(samples: list[dict], current_interval: float) -> float | None:
    """
    POST a batch of readings. On success, return the hub's advised logging
    interval in seconds — the per-device cadence the operator sets from the
    dashboard — so the agent can match its push rate to it; falls back to
    current_interval when the response omits one. Returns None on failure so the
    caller keeps the backlog for the next attempt.
    """
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


def _stop(_signum, _frame) -> None:
    global _running
    _running = False
    log("shutting down")


def main() -> int:
    if not DEVICE_KEY:
        log("DEVICE_KEY is not set — refusing to start. See power-agent.service.")
        return 1

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    log(f"starting: hub={HUB_URL} interval={INTERVAL}s simulate={SIMULATE}")

    buffer: deque[dict] = deque(maxlen=MAX_BUFFER)
    # The hub hands back the operator-set logging cadence on each push; start
    # from the env default until the first successful push tells us otherwise.
    interval = INTERVAL

    while _running:
        cycle_start = time.monotonic()
        try:
            now = utc_now_iso()
            for metric, value in read_power().items():
                buffer.append({"metric": metric, "value": value, "recordedAt": now})
        except NotImplementedError as e:
            log(str(e))
            return 1
        except Exception as e:  # a flaky meter shouldn't kill the agent
            log(f"meter read failed (will retry): {e}")

        # Flush the whole backlog at once; keep it on failure. A successful push
        # echoes the hub's current per-device logging interval — adopt it so a
        # change made from the dashboard takes effect without a redeploy.
        if buffer:
            advised = push(list(buffer), interval)
            if advised is not None:
                buffer.clear()
                if advised != interval:
                    log(f"hub set logging interval to {advised:g}s")
                    interval = advised

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
