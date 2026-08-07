# tilt-agent — Tilt hydrometer (gravity) → hub

Overhears a [Tilt](https://tilthydrometer.com/) floating hydrometer's Bluetooth
beacon and pushes its readings to the BrewPlanner hub. Two metrics show up on the
device's tile and charts:

| Metric       | Meaning                         | Unit |
| ------------ | ------------------------------- | ---- |
| `gravity_sg` | specific gravity (e.g. 1.050)   | SG   |
| `temp_c`     | sample temperature              | °C   |

The Tilt broadcasts an **Apple iBeacon**: the UUID encodes the Tilt's colour,
`major` carries the temperature (°F) and `minor` the specific gravity ×1000. The
agent scans **passively** for the colour you select — the Tilt is never paired or
connected to, just overheard — so a Pi with built-in Bluetooth (Pi 3/4/5/Zero 2
W) needs no extra hardware.

Like the other agents it ships with a **simulate** mode so you can stand up the
whole pipeline before you have a Tilt or a BLE adapter.

## Steps

1. **Register the device on the hub** and copy the printed key:
   ```bash
   DATABASE_PATH=/home/brewplanner/data/checklist.sqlite \
     npm run device -- add "Fermenter" hydrometer
   ```
   Name it exactly `Fermenter` — the dashboard groups sensors into station cards
   by exact device name, so any other name gets its own second Fermenter card
   instead of filling in the Gravity panel on the existing one.
2. **Copy this repo to the satellite Pi** so the agent lives at
   `…/deploy/agents/tilt-agent/`.
3. **Configure it**: create `/etc/tilt-agent.env` (chmod 600) from
   `tilt-agent.env.example`; set `HUB_URL` and `DEVICE_KEY`. Leave
   `BP_SIMULATE=1` for now.
4. **Smoke-test by hand** — run `python3 agent.py`; a "Fermenter Tilt" tile should
   appear on the dashboard, go Online, and show a gravity near 1.030 and a temp
   near 20 °C that drift over time.
5. **Go live**: `pip3 install bleak`, set your Tilt's colour with `TILT_COLOR=…`,
   make sure Bluetooth is up (`bluetoothctl show`), then set `BP_SIMULATE=0`. The
   agent listens `SCAN_SECONDS` each cycle for that colour's beacon.
6. **Run it as a service**: copy `tilt-agent.service` to
   `/etc/systemd/system/`, then `systemctl enable --now tilt-agent`.

### Notes

- Scanning BLE may need privileges. If reads fail with a permission error, grant
  the Python binary the capability once:
  `sudo setcap 'cap_net_raw,cap_net_admin+eip' $(readlink -f $(which python3))`,
  or run the service as `root`. Scanning through BlueZ over D-Bus (the normal
  path) needs neither.
- `No powered Bluetooth adapters found` means the radio is rfkill **soft-blocked**
  — `bluetooth.service` can be active with nothing powered. `bluetoothctl show`
  will say `off-blocked`; clear it with
  `echo 0 | sudo tee /sys/class/rfkill/rfkill0/soft`, then `bluetoothctl power on`.
- On Debian 12+/trixie the system python is externally-managed, so `bleak` needs a
  venv (`python3 -m venv ~/tilt-venv && ~/tilt-venv/bin/pip install bleak`) and
  `ExecStart=` must point at that interpreter.
- The Tilt app's calibration never leaves the app — it doesn't change the beacon.
  Use `TILT_SG_OFFSET` to correct what the dashboard shows.
- A Tilt only beacons every few seconds and sleeps when dry — keep `INTERVAL`
  gentle (≥60s) and make sure the Tilt is floating in liquid.
- Running multiple Tilts? Register one hydrometer device per colour and run a
  `tilt-agent` instance each, with its own `TILT_COLOR` and `/etc/…env`.

See [../../../SENSORS.md](../../../SENSORS.md) for the big picture and the
shared verifying/troubleshooting notes.
