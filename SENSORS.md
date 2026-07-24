# Satellite agents — setup overview

Small services that run on **satellite** machines (extra Raspberry Pis on the
brewery LAN) and push sensor data to the BrewPlanner **hub** — the Pi running
the BrewPlanner server. Each reading shows up on the dashboard as a device tile
with live status and history charts.

```
[satellite] --reads sensor--> agent --POST /api/ingest (Bearer key)--> [hub] --> dashboard
```

The agents:

| Agent | What it does | Metrics |
| ----- | ------------ | ------- |
| [`pressure-agent`](deploy/agents/pressure-agent/) | Reads a fermentation-pressure sensor wired to the satellite Pi | `pressure_bar` |
| [`inkbird-agent`](deploy/agents/inkbird-agent/)   | Polls an Inkbird ITC-308-WIFI fridge/heater controller on the LAN | `temp_c`, `setpoint_c`, `hvac_state` |
| [`power-agent`](deploy/agents/power-agent/)       | Reads the brewery's mains electricity usage | `power_w`, `energy_kwh` |
| [`water-agent`](deploy/agents/water-agent/)       | Reads a water-flow sensor | `flow_lpm`, `water_l` |
| [`tilt-agent`](deploy/agents/tilt-agent/)         | Overhears a Tilt floating hydrometer's BLE beacon | `gravity_sg`, `temp_c` |

Every agent ships a **simulate** mode (`BP_SIMULATE=1`, the default), so each
pipeline can be stood up end-to-end before the matching hardware exists. The
metrics are free-form numbers — the hub stores any `metric`/`value` without a
schema change — so the dashboard picks units from the metric-name suffix
(`_bar`, `_c`, `_w`, `_kwh`, `_lpm`, `_l`) and formats `gravity_sg` specially.

The full, copy-pasteable instructions live in each agent's own `README.md`.
This file is the **rough roadmap** so you know the shape of the job before you
dive in.

## How the pieces fit

- **Hub**: runs the server + dashboard. You register each satellite here with
  `npm run device -- add …`, which prints a one-time **device key** (`bp_…`).
- **Satellite**: runs one agent. It needs the hub's URL, its device key, and
  (for sensors) whatever talks to the hardware. It pushes on an interval and the
  push doubles as a heartbeat, so the dashboard knows when a satellite goes quiet.
- A satellite can be a **separate** Pi or the same hub Pi — but keep the agent's
  config (`/etc/<agent>.env`, chmod 600) out of git; only the device key proves
  identity to the hub.

## Common prerequisites

- The hub is up and reachable from the satellite on the LAN
  (e.g. `http://checklist01.local:3000`). Test with `ping` / a browser first.
- The satellite has Python 3 (`python3 --version`).
- Copy this repo onto the satellite. Only the relevant
  `deploy/agents/<agent>/` folder is actually used there — you don't need to
  build the app on the satellite.

---

## a) Pressure sensor → hub

Full guide: [deploy/agents/pressure-agent/README.md](deploy/agents/pressure-agent/README.md). Rough steps:

1. **Register the device on the hub** and copy the printed key:
   ```bash
   npm run device -- add "Fermenter 1" pressure_sensor
   ```
2. **Copy this repo to the satellite Pi** so the agent lives at
   `…/deploy/agents/pressure-agent/`.
3. **Configure it**: create `/etc/pressure-agent.env` (chmod 600) from
   `pressure-agent.env.example`; set `HUB_URL` and `DEVICE_KEY`. Leave
   `BP_SIMULATE=1` for now.
4. **Smoke-test by hand** — run `agent.py`; a "Fermenter 1" tile should appear
   on the dashboard, go Online, and show a value that drifts every 30s.
5. **Run it as a service**: copy `pressure-agent.service` to
   `/etc/systemd/system/`, then `systemctl enable --now pressure-agent`.
6. **Wire the real sensor**: implement `read_pressure()` in `agent.py` for your
   hardware (there's a worked ADS1115 example in the docstring), then set
   `BP_SIMULATE=0` and restart the service.

> No physical sensor yet? Leave `BP_SIMULATE=1` to demo the whole pipeline
> end-to-end first.

---

## b) Inkbird ITC-308-WIFI → hub

Full guide: [deploy/agents/inkbird-agent/README.md](deploy/agents/inkbird-agent/README.md). The ITC-308-WIFI
is a Tuya device, so the agent reads it locally over the LAN with `tinytuya` —
no extra wiring, but there's a **one-time pairing** to get its local key. Rough
steps:

1. **Register the device on the hub** and copy the printed key:
   ```bash
   npm run device -- add "Fermenter Controller" brew_controller
   ```
2. **Get the controller's local key** (one-time): `pip3 install tinytuya` then
   `python3 -m tinytuya wizard`. Link your Inkbird/Tuya account (free Tuya IoT
   project) and note the controller's **device id**, **LAN IP**, and **local
   key** from the generated `devices.json`.
3. **Copy this repo to the satellite Pi** (`…/deploy/agents/inkbird-agent/`) and
   `pip3 install tinytuya` there.
4. **Configure it**: create `/etc/inkbird-agent.env` (chmod 600) from
   `inkbird-agent.env.example`; set `HUB_URL`, `DEVICE_KEY`, and the three
   `INKBIRD_*` values. Leave `BP_SIMULATE=1` for now.
5. **Smoke-test by hand** — run `agent.py`; a "Fermenter Controller" tile should
   appear with `temp_c` ~18 °C and an `hvac_state` of Cooling/Idle/Heating. Then set
   `BP_SIMULATE=0` and confirm the values match the controller's own display.
6. **Run it as a service**: copy `inkbird-agent.service` to
   `/etc/systemd/system/`, then `systemctl enable --now inkbird-agent`.

> Poll gently (interval ≥ 30s, the default): the ITC-308-WIFI drops frequent
> pollers with an "Err 914" lock-up. See the agent README's Notes for details.

---

## c) Brewery temperature (another Inkbird ITC-308) → hub

The brewery's ambient thermometer is just **another ITC-308**, so it reuses the
same [`inkbird-agent`](deploy/agents/inkbird-agent/) — no new code. Register a
second device and run a second agent instance:

```bash
npm run device -- add "Brewery Ambient" brew_controller
```

Give it its own `/etc/inkbird-agent-ambient.env` and a copy of the systemd unit
(e.g. `inkbird-agent-ambient.service`) pointing at the second controller's
`INKBIRD_*` values. On the dashboard the "Brewery Temperature" placeholder card
hides once a `brew_controller` named *Brewery*/*Ambient* starts reporting.

---

## d) Electricity (power + energy) → hub

Full guide: [deploy/agents/power-agent/README.md](deploy/agents/power-agent/README.md). Rough steps:

1. Register: `npm run device -- add "Brewery Power" power_meter`.
2. Copy the repo to the satellite; configure `/etc/power-agent.env` from the
   example (`HUB_URL`, `DEVICE_KEY`), leave `BP_SIMULATE=1`.
3. Smoke-test `agent.py` — a "Brewery Power" tile reports `power_w` + a climbing
   `energy_kwh`. Then implement `read_power()` (Tuya/Shelly/CT-clamp examples in
   the docstring) and set `BP_SIMULATE=0`.

---

## e) Water usage → hub

Full guide: [deploy/agents/water-agent/README.md](deploy/agents/water-agent/README.md). Rough steps:

1. Register: `npm run device -- add "Brewery Water" water_meter`.
2. Configure `/etc/water-agent.env`, leave `BP_SIMULATE=1`.
3. Smoke-test — a "Brewery Water" tile reports `flow_lpm` + a climbing
   `water_l`. Then implement `read_water()` (a hall-effect flow-sensor example is
   in the docstring; persist the running total) and set `BP_SIMULATE=0`.

---

## f) Tilt hydrometer (gravity) → hub

Full guide: [deploy/agents/tilt-agent/README.md](deploy/agents/tilt-agent/README.md). The Tilt broadcasts an
Apple iBeacon, so the agent **passively scans** for it over BLE — no pairing, no
wiring, but it needs a Bluetooth adapter on the host. Rough steps:

1. Register: `npm run device -- add "Fermenter Tilt" hydrometer`.
2. Configure `/etc/tilt-agent.env`, set `TILT_COLOR` to your Tilt's colour, leave
   `BP_SIMULATE=1`.
3. Smoke-test — a "Fermenter Tilt" tile reports `gravity_sg` (≈1.030) and
   `temp_c`. To go live: `pip3 install bleak`, ensure Bluetooth is up, set
   `BP_SIMULATE=0`.

> BLE scanning may need privileges — see the agent README's Notes
> (`setcap`, or run as root) if live reads fail with a permission error.

---

## Verifying & troubleshooting (all agents)

- **Tile never appears / stays Offline** → the push isn't landing. Check the
  agent logs (`journalctl -u <agent> -f`), confirm `HUB_URL` is reachable, and
  that `DEVICE_KEY` matches a registered device (a `401` in the logs means a
  bad/empty key — re-issue with `npm run device -- rotate "<name>"`).
- **Online window**: online/offline is derived from the freshness of the last
  *reading*, not merely the last time the agent contacted the hub. A device shows
  Offline once it has missed several of its own reporting cycles with no new
  reading — `DEVICE_ONLINE_MISS_CYCLES` (default 3) × the device's reporting
  interval, but never less than a `DEVICE_ONLINE_WINDOW_SECONDS` floor (default
  90s). This tolerates the odd dropped poll (e.g. an Inkbird's flaky Tuya read)
  while still flagging a controller that has genuinely stopped reporting.
- **Lost a device key?** `npm run device -- rotate "<name>"` issues a new one
  (the old one stops working). `npm run device -- list` shows all devices and
  when each was last seen.
- **Adding more sensors**: copy an agent folder, register another device, give
  it its own metric(s) and `/etc/<name>.env` + systemd unit.
