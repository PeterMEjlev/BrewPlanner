#!/usr/bin/env python3
"""
Tilt hydrometer agent for a satellite Raspberry Pi.

Listens for a Tilt floating hydrometer's Bluetooth beacon and pushes its
readings to the BrewPlanner hub's ingestion API (POST /api/ingest), where they
show up on the dashboard and the device's history charts. Reports two metrics:

  gravity_sg  specific gravity, e.g. 1.050 (Tilt reports thousandths)
  temp_c      sample temperature in degrees Celsius

The Tilt broadcasts an Apple iBeacon: the beacon UUID encodes the Tilt's colour,
its `major` field is the temperature in degrees Fahrenheit, and its `minor`
field is the specific gravity x1000. We scan passively for the colour we care
about — the Tilt isn't paired or connected to, just overheard.

In simulate mode this uses only the Python standard library; live reads need
`bleak` (pip3 install bleak) and a working Bluetooth adapter on the host.

Configuration (all via environment, see tilt-agent.service):
  HUB_URL       Base URL of the hub, e.g. http://checklist01.local:3000
  DEVICE_KEY    The device key printed by `npm run device -- add ...` on the hub
  INTERVAL      Seconds between reads (default: 60 — Tilts beacon slowly)
  TILT_COLOR    Which Tilt to track: red/green/black/purple/orange/blue/
                yellow/pink (default: black)
  SCAN_SECONDS  How long to listen for a beacon each read (default: 15)
  TILT_SG_OFFSET     Added to every gravity reading (default: 0). The Tilt app's
                own calibration never leaves the app — it doesn't touch the
                beacon — so a Tilt that reads e.g. 0.985 floating in plain water
                needs its correction applied here instead: TILT_SG_OFFSET=0.015.
  TILT_TEMP_OFFSET_C Added to every temperature reading in degrees C (default: 0)
  BP_SIMULATE   If "1" (the default until you have a Tilt + BLE adapter), report
                synthetic values so the whole pipeline can be verified first.

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
import uuid
from collections import deque
from datetime import datetime, timezone

HUB_URL = os.environ.get("HUB_URL", "http://localhost:3000").rstrip("/")
DEVICE_KEY = os.environ.get("DEVICE_KEY", "")
INTERVAL = float(os.environ.get("INTERVAL", "60"))
SIMULATE = os.environ.get("BP_SIMULATE", "1") == "1"
TILT_COLOR = os.environ.get("TILT_COLOR", "black").strip().lower()
SCAN_SECONDS = float(os.environ.get("SCAN_SECONDS", "15"))
# Calibration trims, applied to the raw beacon values (see the module docstring).
SG_OFFSET = float(os.environ.get("TILT_SG_OFFSET", "0"))
TEMP_OFFSET_C = float(os.environ.get("TILT_TEMP_OFFSET_C", "0"))

# Apple iBeacon UUID per Tilt colour (the major/minor carry temp & gravity).
TILT_UUIDS = {
    "red": "a495bb10c5b14b44b5121370f02d74de",
    "green": "a495bb20c5b14b44b5121370f02d74de",
    "black": "a495bb30c5b14b44b5121370f02d74de",
    "purple": "a495bb40c5b14b44b5121370f02d74de",
    "orange": "a495bb50c5b14b44b5121370f02d74de",
    "blue": "a495bb60c5b14b44b5121370f02d74de",
    "yellow": "a495bb70c5b14b44b5121370f02d74de",
    "pink": "a495bb80c5b14b44b5121370f02d74de",
}

# Cap the backlog so a long outage can't grow memory without bound. Each cycle
# pushes 2 metrics; 2880 samples is ~24h at one cycle every 60s.
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
    print(f"[tilt-agent] {msg}", flush=True)


def f_to_c(f: float) -> float:
    return (f - 32.0) * 5.0 / 9.0


def read_tilt() -> dict[str, float]:
    """
    Return the Tilt's current metrics as a dict of metric -> value.

    Keys: gravity_sg (specific gravity, e.g. 1.050), temp_c (degrees Celsius).

    Until you have a Tilt and a Bluetooth adapter (and BP_SIMULATE=0), this
    returns a synthetic fermentation-like curve so the agent -> hub -> dashboard
    pipeline can be verified end to end.
    """
    if SIMULATE:
        # Gravity drifting across a typical fermentation range (~1.010-1.050) and
        # temperature wobbling around 20C — purely synthetic, just to show motion.
        now = time.time()
        gravity = round(1.030 + 0.020 * math.sin(now / 3600.0), 3)
        temp_c = round(20.0 + 1.5 * math.sin(now / 1800.0), 2)
        return {"gravity_sg": gravity, "temp_c": temp_c}

    if TILT_COLOR not in TILT_UUIDS:
        raise RuntimeError(
            f"TILT_COLOR={TILT_COLOR!r} is not a known Tilt colour. Use one of: "
            + ", ".join(TILT_UUIDS)
        )

    # Imported lazily so SIMULATE mode needs no pip install / BLE adapter.
    import asyncio

    from bleak import BleakScanner  # pip3 install bleak

    target = TILT_UUIDS[TILT_COLOR]
    seen: dict[str, int] = {}

    async def scan() -> None:
        def on_adv(_device, adv) -> None:
            # Apple's company id is 0x004C; iBeacon payload starts 0x02 0x15.
            md = adv.manufacturer_data.get(0x004C)
            if not md or len(md) < 23 or md[0] != 0x02 or md[1] != 0x15:
                return
            if md[2:18].hex() != target:
                return
            seen["temp_f"] = int.from_bytes(md[18:20], "big")  # major = temp F
            seen["sg_x1000"] = int.from_bytes(md[20:22], "big")  # minor = SG*1000

        scanner = BleakScanner(detection_callback=on_adv)
        await scanner.start()
        await asyncio.sleep(SCAN_SECONDS)
        await scanner.stop()

    asyncio.run(scan())

    if "sg_x1000" not in seen:
        raise RuntimeError(
            f"no {TILT_COLOR} Tilt beacon seen in {SCAN_SECONDS:.0f}s — check the "
            "Tilt is awake (floating in liquid) and the BLE adapter is up."
        )
    # Offsets are applied to real reads only — simulate mode stays a clean test of
    # the agent -> hub -> dashboard path, unskewed by this Tilt's calibration.
    return {
        "gravity_sg": round(seen["sg_x1000"] / 1000.0 + SG_OFFSET, 3),
        "temp_c": round(f_to_c(seen["temp_f"]) + TEMP_OFFSET_C, 2),
    }


def host_mac() -> str | None:
    """
    Best-effort MAC of this host's primary interface, reported to the hub so the
    Devices page can show a stable hardware id (the link-layer address never
    survives the trip over IP). Returns None when only a random/locally-
    administered address is available — uuid.getnode()'s fallback when it can't
    find real hardware — so the hub leaves the field blank rather than storing a
    meaningless value. Computed once into MAC below; it doesn't change at runtime.
    """
    node = uuid.getnode()
    # getnode() sets the multicast bit (the low bit of the first octet) only when
    # it had to invent a random address; a real NIC MAC never has it set.
    if (node >> 40) & 0x01:
        return None
    return ":".join(f"{(node >> shift) & 0xFF:02x}" for shift in range(40, -8, -8))


MAC = host_mac()


def push(samples: list[dict], current_interval: float) -> float | None:
    """
    POST a batch of readings. On success, return the hub's advised logging
    interval in seconds — the per-device cadence the operator sets from the
    dashboard — so the agent can match its push rate to it; falls back to
    current_interval when the response omits one. Returns None on failure so the
    caller keeps the backlog for the next attempt.
    """
    payload: dict = {"readings": samples}
    if MAC:
        payload["mac"] = MAC
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


def _stop(_signum, _frame) -> None:
    global _running
    _running = False
    log("shutting down")


def main() -> int:
    if not DEVICE_KEY:
        log("DEVICE_KEY is not set — refusing to start. See tilt-agent.service.")
        return 1

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    log(
        f"starting: hub={HUB_URL} interval={INTERVAL}s simulate={SIMULATE} "
        f"color={TILT_COLOR}"
    )

    buffer: deque[dict] = deque(maxlen=MAX_BUFFER)
    # The hub hands back the operator-set logging cadence on each push; start
    # from the env default until the first successful push tells us otherwise.
    interval = INTERVAL

    while _running:
        try:
            now = utc_now_iso()
            for metric, value in read_tilt().items():
                buffer.append({"metric": metric, "value": value, "recordedAt": now})
        except Exception as e:  # a missed beacon / flaky BLE shouldn't kill us
            log(f"read failed (will retry): {e}")

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

        # Sleep to the next round wall-clock slot, waking early on shutdown.
        sleep_until(next_slot(interval))

    return 0


if __name__ == "__main__":
    sys.exit(main())
