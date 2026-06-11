# Fermentation-pressure agent

A tiny standalone service for a **satellite** Raspberry Pi (the one wired to the
fermentation-pressure sensor). It reads the sensor on an interval and pushes the
value to the BrewPlanner **hub** over the LAN, where it shows up on the
dashboard and the device's history chart.

```
[sensor Pi] --reads sensor--> agent.py --POST /api/ingest--> [hub Pi] --> dashboard
```

The agent uses only the Python standard library, so there's nothing to `pip
install` unless your sensor's own driver needs it.

## 1. Register the device on the hub

On the **hub** Pi (the one running the BrewPlanner server):

```bash
npm run device -- add "Fermenter 1" pressure_sensor
```

This prints a device key **once** (`bp_…`). Copy it — it isn't recoverable.
(`npm run device -- rotate "Fermenter 1"` issues a new one if you lose it.)

## 2. Put the agent on the satellite Pi

The simplest path is to clone/copy this repo to the satellite too, so the agent
lives at `/home/pi/checklist/deploy/agents/pressure-agent/`. (Only this folder
is actually used; you don't need to build the app on the satellite.)

## 3. Configure it

```bash
sudo install -m 600 /dev/null /etc/pressure-agent.env
sudo nano /etc/pressure-agent.env       # use pressure-agent.env.example as a guide
```

Set at least:

- `HUB_URL` — e.g. `http://checklist01.local:3000` (the hub's hostname + port)
- `DEVICE_KEY` — the `bp_…` key from step 1

Leave `BP_SIMULATE=1` for now so you can verify the pipeline before the sensor
is wired.

## 4. Smoke-test by hand

```bash
set -a; . /etc/pressure-agent.env; set +a
python3 /home/pi/checklist/deploy/agents/pressure-agent/agent.py
```

You should see `starting: …` then nothing else (it pushes silently on success).
Open the hub dashboard — a **Fermenter 1** tile should appear, go **Online**,
and show a value that drifts every 30s. Open the tile to see the chart. `Ctrl-C`
to stop.

## 5. Run it as a service

```bash
sudo cp pressure-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pressure-agent.service
journalctl -u pressure-agent.service -f
```

## 6. Wire the real sensor

Edit `read_pressure()` in [agent.py](agent.py) to read your hardware and return
a float (in the unit your `METRIC` implies — `pressure_bar` ⇒ bar). There's a
worked ADS1115 example in the docstring. Then set `BP_SIMULATE=0` in
`/etc/pressure-agent.env` and `sudo systemctl restart pressure-agent.service`.

## Notes

- **Online/offline** on the dashboard is derived from the last push time; the
  default window is 90s (override with `DEVICE_ONLINE_WINDOW_SECONDS` on the
  hub). With a 30s interval the tile tolerates a couple of missed pushes.
- **Outages**: if the hub is briefly unreachable, readings are buffered in
  memory (up to ~24h) and flushed on reconnect.
- **More sensors**: copy this folder per sensor, register another device, give
  each its own `METRIC` and `/etc/<name>.env` + unit file. Temperature would be
  `METRIC=temp_c`, for example.
