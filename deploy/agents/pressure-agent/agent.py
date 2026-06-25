#!/usr/bin/env python3
"""
Fermentation-pressure agent for a satellite Raspberry Pi.

Reads a pressure sensor on an interval and pushes the value to the BrewPlanner
hub's ingestion API (POST /api/ingest). Uses only the Python standard library
so the Pi needs no pip install beyond whatever your sensor's own driver needs.

Configuration (all via environment, see pressure-agent.service):
  HUB_URL      Base URL of the hub, e.g. http://checklist01.local:3000
  DEVICE_KEY   The device key printed by `npm run device -- add ...` on the hub
  METRIC       Metric name to report (default: pressure_bar)
  INTERVAL     Seconds between reads (default: 30)
  BP_SIMULATE  If "1" (the default until you wire a real sensor), report a
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
METRIC = os.environ.get("METRIC", "pressure_bar")
INTERVAL = float(os.environ.get("INTERVAL", "30"))
SIMULATE = os.environ.get("BP_SIMULATE", "1") == "1"

# Cap the backlog so a long outage can't grow memory without bound
# (2880 samples ≈ 24h at one every 30s).
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
    print(f"[pressure-agent] {msg}", flush=True)


def read_pressure() -> float:
    """
    Return the current pressure as a float in the unit implied by METRIC
    (default bar).

    >>> TODO: replace the body below with your real sensor read. <<<

    Example for an analog pressure transducer on an ADS1115 I2C ADC:

        import board, busio
        import adafruit_ads1x15.ads1115 as ADS
        from adafruit_ads1x15.analog_in import AnalogIn
        # set up once at module load, then per read:
        #   voltage = AnalogIn(ads, ADS.P0).voltage
        #   return (voltage - V_AT_ZERO) * BAR_PER_VOLT

    Until then, BP_SIMULATE=1 produces a gently varying synthetic curve so the
    end-to-end pipeline (agent → hub → dashboard chart) can be verified.
    """
    if SIMULATE:
        # A slow ~1.0–1.6 bar wave, as a fermentation might trend.
        t = time.time() / 600.0  # 10-minute period
        return round(1.3 + 0.3 * math.sin(t), 3)
    raise NotImplementedError(
        "read_pressure() is not implemented. Wire your sensor here, or set "
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
        log("DEVICE_KEY is not set — refusing to start. See pressure-agent.service.")
        return 1

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    log(
        f"starting: hub={HUB_URL} metric={METRIC} interval={INTERVAL}s "
        f"simulate={SIMULATE}"
    )

    buffer: deque[dict] = deque(maxlen=MAX_BUFFER)
    # The hub hands back the operator-set logging cadence on each push; start
    # from the env default until the first successful push tells us otherwise.
    interval = INTERVAL

    while _running:
        cycle_start = time.monotonic()
        try:
            value = read_pressure()
            buffer.append({"metric": METRIC, "value": value, "recordedAt": utc_now_iso()})
        except NotImplementedError as e:
            log(str(e))
            return 1
        except Exception as e:  # a flaky sensor shouldn't kill the agent
            log(f"sensor read failed: {e}")

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
