# Inkbird ITC-308-WIFI agent

A standalone service for a **satellite** Raspberry Pi (one on the same LAN as
the Inkbird controller). It polls the ITC-308-WIFI fridge/heater controller and
pushes its readings to the BrewPlanner **hub**, where they show up on the
dashboard and the device's history charts.

```
[ITC-308-WIFI] <--LAN (tinytuya)-- agent.py --POST /api/ingest--> [hub Pi] --> dashboard
```

It reports three metrics every cycle:

| metric        | meaning                                            |
| ------------- | -------------------------------------------------- |
| `temp_c`      | current fermentation temperature (°C)              |
| `setpoint_c`  | the controller's target temperature (°C)           |
| `hvac_state`  | active relay: `-1` cooling, `0` idle, `+1` heating |

The ITC-308-WIFI is a **Tuya** device, so reads are done locally with the
[`tinytuya`](https://github.com/jasonacox/tinytuya) library — no cloud
round-trip once it's set up. (The HTTP push to the hub uses only the standard
library, like the pressure agent.)

## 1. Register the device on the hub

On the **hub** Pi (the one running the BrewPlanner server):

```bash
npm run device -- add "Fermenter Controller" brew_controller
```

This prints a device key **once** (`bp_…`). Copy it — it isn't recoverable.
(`npm run device -- rotate "Fermenter Controller"` issues a new one if you lose it.)

## 2. Get the Inkbird's local key (one-time)

Local reads need the controller's **device id**, **LAN IP**, and **local key**.
The local key is only obtainable by linking your Inkbird/Tuya account to a free
Tuya IoT developer project once. `tinytuya`'s wizard automates it:

```bash
pip3 install tinytuya          # on the satellite Pi (or any machine)
python3 -m tinytuya wizard
```

Follow the prompts (you'll create a free account at iot.tuya.com, add a Cloud
project, and link the Inkbird app via "Link Tuya App Account"). The wizard
writes `devices.json` listing each device's `id`, `ip`, `key` (the local key),
and `version`. Find the ITC-308-WIFI entry and note those four values.

> The Inkbird/InkbirdPro and Tuya "Smart Life" apps share the same backend, so
> if the controller is already in the Inkbird app it'll appear here.

If the wizard doesn't capture the IP, find it from your router's DHCP table or
`python3 -m tinytuya scan`.

## 3. Put the agent on the satellite Pi

Copy this repo to the satellite so the agent lives at
`/home/pi/checklist/deploy/agents/inkbird-agent/`. (Only this folder is used;
you don't need to build the app on the satellite.) Then:

```bash
pip3 install tinytuya
```

## 4. Configure it

```bash
sudo install -m 600 /dev/null /etc/inkbird-agent.env
sudo nano /etc/inkbird-agent.env       # use inkbird-agent.env.example as a guide
```

Set at least:

- `HUB_URL` — e.g. `http://checklist01.local:3000`
- `DEVICE_KEY` — the `bp_…` key from step 1
- `INKBIRD_DEVICE_ID`, `INKBIRD_IP`, `INKBIRD_LOCAL_KEY` — from step 2

Leave `BP_SIMULATE=1` for now so you can verify the pipeline before relying on
the real reads.

## 5. Smoke-test by hand

```bash
set -a; . /etc/inkbird-agent.env; set +a
python3 /home/pi/checklist/deploy/agents/inkbird-agent/agent.py
```

You should see `starting: …` then nothing else (it pushes silently on success).
Open the hub dashboard — a **Fermenter Controller** tile should appear, go
**Online**, and show `temp_c` drifting around 18 °C with the `hvac_state` pill
cycling between Cooling / Idle / Heating. Open the tile to see the charts.
`Ctrl-C` to stop.

Then set `BP_SIMULATE=0` and run it again — the values should now match what the
controller's own display shows (temperature and setpoint within rounding; the
relay metrics flip with the fridge/heater).

## 6. Run it as a service

```bash
sudo cp inkbird-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now inkbird-agent.service
journalctl -u inkbird-agent.service -f
```

## Notes

- **Reliability**: the ITC-308-WIFI is known to drop frequent pollers with an
  "Err 914" if a socket is held open. The agent opens a fresh, non-persistent
  connection each cycle and defaults to a gentle 30s interval to avoid this. If
  reads start failing, power-cycling the controller clears it.
- **Protocol version**: defaults to `3.4` (correct for the ITC-308-WIFI). If
  every read fails immediately with a decode/key error, try `INKBIRD_VERSION=3.3`.
- **°C / °F**: the agent reads the controller's unit setting and always reports
  `temp_c`/`setpoint_c` in Celsius, converting if the controller is set to °F.
- **Online/offline** on the dashboard is derived from the last push time (default
  90s window, override with `DEVICE_ONLINE_WINDOW_SECONDS` on the hub). A 30s
  interval tolerates a couple of missed reads.
- **Outages**: if the hub is briefly unreachable, readings are buffered in memory
  (~12h) and flushed on reconnect.
