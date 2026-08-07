# Joining a Tilt hydrometer to BrewPlanner

A start-to-finish playbook for getting a **Tilt floating hydrometer** logging
gravity and temperature into BrewPlanner. It covers the **physical** setup
(calibrating and floating the Tilt) and **every command** you'll run, so the day
you decide to do this it's a smooth job.

When it's done you get a device tile on the dashboard showing live
**specific gravity** (e.g. 1.050) and **sample temperature**, with history
charts that let you watch a fermentation curve flatten out.

> This guide is the friendly walkthrough. The terse reference lives in
> [../deploy/agents/tilt-agent/README.md](../deploy/agents/tilt-agent/README.md);
> the big-picture roadmap is in [../SENSORS.md](../SENSORS.md).

---

## How it fits together

```
[Tilt in the fermenter] ~~BLE iBeacon~~> [satellite Pi: tilt-agent] --POST /api/ingest--> [hub Pi] --> dashboard
   floating, beaconing       overheard          agent.py + bleak       Bearer device key    checklist01.local
```

- **Hub** = the Pi already running BrewPlanner (`checklist01.local:3000`).
- **Satellite** = a Pi running the `tilt-agent` script. It can be a **separate**
  Pi *or the same hub Pi*. The key constraint here is **Bluetooth range and
  walls**: the Pi must be close enough to the fermenter to overhear the Tilt's
  BLE beacon (a metre or two through a fridge door is usually fine; across the
  building is not).
- The Tilt broadcasts an **Apple iBeacon** — it is **never paired or connected
  to**, just passively overheard. So there's **no pairing step, no wiring**, and
  no Tuya/cloud account. You just need a Pi with Bluetooth (Pi 3/4/5/Zero 2 W
  all have it built in) within range.

### What you need before you start

- [ ] A Tilt, and you know its **colour** (the colour *is* its identity on BLE).
- [ ] A satellite Pi with working Bluetooth, within BLE range of the fermenter.
- [ ] SSH access to the hub Pi, and to the satellite Pi if it's a separate one.
- [ ] (Optional but recommended) the Tilt phone app for a quick sanity check and
      calibration before you commit it to a batch.

---

## Part A — Physical / real-world setup

Skip this if your Tilt is already calibrated and you know it reads correctly.

### 1. Wake it and check the battery

The Tilt sleeps when stored. Turning it upside-down for a few seconds activates
it (it has a tilt switch). A fresh **CR123A** battery lasts a full season; if the
Tilt has been sitting for months, swap it now — a dying battery is the #1 cause
of dropped readings mid-fermentation. To replace it, unscrew the cap, swap the
cell, and **reseal the cap firmly** so no wort gets in.

### 2. Calibrate in distilled water (strongly recommended)

A Tilt should read **1.000** in plain water at its calibration temperature.

1. Sanitize the Tilt (see step 4) and float it in **plain water** at room
   temperature — distilled/RO is ideal, but tap water is within ~0.001 and fine
   for this. Use a vessel tall and wide enough that it bobs upright without
   leaning on the sides or touching the bottom, or it will read low.
2. Let the reading **settle**. The Tilt reads high while it's still cooling to
   the water's temperature; wait until `temp_c` stops moving (a few minutes),
   then take the gravity.
3. It should read **1.000**. If it doesn't, set the difference as
   `TILT_SG_OFFSET` in `/etc/tilt-agent.env` (Part D) — e.g. a Tilt reading
   0.9835 needs `TILT_SG_OFFSET=0.0165`.

> **Do not calibrate in the Tilt app and expect the dashboard to follow.** The
> app's offset never leaves the app — it doesn't change what the Tilt
> broadcasts, and BrewPlanner logs the raw beacon value. `TILT_SG_OFFSET` is the
> only correction that reaches the dashboard.

### 3. Note your Tilt's colour

The colour is how the agent identifies your Tilt on the airwaves. Valid colours:
**red, green, black, purple, orange, blue, yellow, pink**. You'll set this as
`TILT_COLOR` later. If you run more than one Tilt, each must be a different colour.

### 4. Sanitize and drop it in

1. **Sanitize** the Tilt (e.g. soak in Star San) just like any other equipment
   that touches the wort — it floats freely in the fermenting beer.
2. **Drop it into the fermenter** *before* fermentation, or through the lid/port.
   It floats upright and bobs as density changes.
3. Make sure nothing tethers it at an angle and that it can float freely —
   trapped against the wall or under krausen it reads wrong.

> The Tilt only beacons every few seconds and **sleeps when dry**, so it must be
> floating in liquid for readings to appear. Don't expect data from a Tilt
> sitting on the bench.

---

## Part B — Register the device on the hub

This mints the credential the agent uses to push readings.

**SSH into the hub Pi** and, from the project directory, run:

```bash
cd /home/brewplanner/checklist        # wherever BrewPlanner is checked out
DATABASE_PATH=/home/brewplanner/data/checklist.sqlite \
  npm run device -- add "Fermenter" hydrometer
```

> **Set `DATABASE_PATH`.** Without it the CLI writes to the repo's own
> `apps/server/data/checklist.sqlite` — a *different* database from the one the
> live server reads — and the agent's pushes come back `HTTP 401`.

> **The name matters.** The dashboard groups sensors into station cards by
> *exact* device name (`groupByName` in `Dashboard.tsx`), so a hydrometer named
> `"Fermenter Tilt"` gets its **own second Fermenter card** instead of filling in
> the Gravity panel on the existing one. Name it exactly `Fermenter`, matching the
> fridge controller and the mock profile.

This prints a **device key** starting with `bp_…`, **once**. Copy it somewhere
safe now — it is not recoverable.

- Lost it later? `npm run device -- rotate "Fermenter"` issues a new one. Note
  that rotate/delete match on name and take the *first* hit, so with the Inkbird
  also called `Fermenter` you may need to disambiguate by id in SQL.
- `npm run device -- list` shows every device and when it was last seen.

> Running multiple Tilts? They'd share a station card only if they share a name,
> so give each its own (e.g. `"Fermenter 2"`) and run one agent instance each,
> with its own `TILT_COLOR` and env file.

---

## Part C — Put the agent on the satellite Pi

> Same-Pi setup? If the satellite **is** the hub Pi, the repo is already there —
> skip the copy and continue.

**Copy the repo** to the satellite Pi so the agent lives at
`/home/pi/checklist/deploy/agents/tilt-agent/`. (Only this folder is used; you
don't need to build the whole app there.) Easiest is `git clone` of your repo,
or `scp -r` the project over.

No dependency is needed yet — simulate mode uses only the Python standard
library. You'll `pip3 install bleak` in Part F when you go live.

---

## Part D — Configure the agent

Create the env file (root-only readable) using
[../deploy/agents/tilt-agent/tilt-agent.env.example](../deploy/agents/tilt-agent/tilt-agent.env.example)
as your guide:

```bash
sudo install -m 600 /dev/null /etc/tilt-agent.env
sudo nano /etc/tilt-agent.env
```

Fill in:

```ini
HUB_URL=http://checklist01.local:3000      # the hub Pi's address
DEVICE_KEY=bp_xxxxxxxxxxxx                  # the key from Part B
INTERVAL=60                                 # Tilts beacon slowly; keep >=60
TILT_COLOR=black                            # YOUR Tilt's colour (Part A.3)
SCAN_SECONDS=15                             # how long to listen each cycle
BP_SIMULATE=1                               # leave 1 for the first smoke-test
TILT_SG_OFFSET=0                            # calibration trim from Part A.2
TILT_TEMP_OFFSET_C=0                        # ditto for temperature
```

> `HUB_URL` is `http://localhost:3000` when the agent runs on the hub Pi itself,
> which avoids depending on mDNS resolving.

Save and exit (`Ctrl+O`, Enter, `Ctrl+X`).

---

## Part E — Smoke-test (still simulated)

This proves the agent → hub → dashboard pipeline works **before** you depend on
real BLE reads.

```bash
set -a; . /etc/tilt-agent.env; set +a
python3 /home/pi/checklist/deploy/agents/tilt-agent/agent.py
```

You should see `starting: …` and then it goes quiet (it pushes silently on
success). On the hub dashboard, a **Fermenter Tilt** tile should appear, go
**Online**, and show a gravity near 1.030 and a temp near 20 °C that drift over
time. Open the tile to see the charts. `Ctrl-C` to stop.

If the tile never appears, jump to **Troubleshooting** below.

---

## Part F — Go live (real BLE reads)

1. **Install the BLE dependency** on the satellite:

   ```bash
   pip3 install bleak
   ```

2. **Confirm Bluetooth is up**:

   ```bash
   bluetoothctl show       # should list a controller that is "Powered: yes"
   ```

   If there's no controller, enable it: `sudo systemctl enable --now bluetooth`.

3. **Grant BLE scan privileges** (otherwise live reads fail with a permission
   error). Do this once:

   ```bash
   sudo setcap 'cap_net_raw,cap_net_admin+eip' $(readlink -f $(which python3))
   ```

   (Alternatively, run the service as `root` in Part G.)

4. **Flip to live** and run it by hand:

   ```bash
   sudo nano /etc/tilt-agent.env       # set BP_SIMULATE=0
   set -a; . /etc/tilt-agent.env; set +a
   python3 /home/pi/checklist/deploy/agents/tilt-agent/agent.py
   ```

   With the Tilt floating in liquid and in range, within a cycle or two the
   dashboard should show its **real** gravity and temperature. Cross-check the
   gravity against the Tilt app or a manual hydrometer reading. `Ctrl-C` to stop.

   > Seeing `no <colour> Tilt beacon seen in 15s`? The Tilt is asleep (not
   > floating in liquid), out of range, the wrong `TILT_COLOR`, or Bluetooth/the
   > capability isn't set — see Troubleshooting.

---

## Part G — Run it as a service (survives reboots)

```bash
cd /home/pi/checklist/deploy/agents/tilt-agent
sudo cp tilt-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tilt-agent.service
journalctl -u tilt-agent.service -f       # watch the logs; Ctrl-C to stop watching
```

> The shipped unit runs as user `pi` and expects the agent at
> `/home/pi/checklist/...`. If your satellite uses a different user or path, edit
> the `User=` and `ExecStart=` lines in the `.service` file before copying it. If
> you chose to skip the `setcap` step, set `User=root` here so scanning works.

Done. The Tilt now reports continuously, and the push doubles as a heartbeat
(the tile goes Offline if nothing arrives for ~90s).

---

## Troubleshooting

| Symptom | Likely cause / fix |
| ------- | ------------------ |
| Tile never appears, or stays **Offline** | The push isn't landing. Check `journalctl -u tilt-agent -f`, confirm `HUB_URL` is reachable from the satellite (`curl http://checklist01.local:3000/api/active`). |
| Logs show **`push rejected: HTTP 401`** | Bad/empty `DEVICE_KEY`. Re-issue with `npm run device -- rotate "Fermenter Tilt"` on the hub and update the env. |
| **`no <colour> Tilt beacon seen`** | Tilt is dry/asleep (must float in liquid), out of BLE range, wrong `TILT_COLOR`, or Bluetooth isn't up. Move the Pi closer, confirm the colour, check `bluetoothctl show`. |
| Live read fails with a **permission error** | BLE scanning needs privileges — run the `setcap` command in Part F.3, or run the service as `root`. (Not needed when `bleak` scans via BlueZ over D-Bus, which is the normal path.) |
| **`BleakBluetoothNotAvailableError: No powered Bluetooth adapters found`** | The radio is rfkill **soft-blocked** — `bluetooth.service` can be active with no adapter powered. Check `bluetoothctl show \| grep -E 'Powered\|PowerState'`; if it says `off-blocked`, run `echo 0 \| sudo tee /sys/class/rfkill/rfkill0/soft`, then `bluetoothctl power on`, and set `AutoEnable=true` in `/etc/bluetooth/main.conf` so it survives a reboot. (The `rfkill` CLI isn't installed on a stock Pi image.) |
| **`error: externally-managed-environment`** from `pip3 install bleak` | Debian 12+/trixie won't install into the system python. Use a venv — `python3 -m venv ~/tilt-venv && ~/tilt-venv/bin/pip install bleak` — and point `ExecStart=` at `~/tilt-venv/bin/python`. |
| Gravity is stuck at a nonsense value (0.9, 1.3…) | The Tilt isn't floating upright — on the bench or inverted it reads garbage. Only a free-floating Tilt reads true. |
| Gravity reads slightly off | Check your distilled-water calibration (Part A.2). BrewPlanner logs the **raw** beacon value, not the app's calibrated value. |
| Readings drop out partway through a batch | Usually a **dying CR123A battery** — swap it. Also confirm the Tilt isn't trapped under krausen or against the wall. |
| Hub was briefly down | No action needed — readings are buffered in memory (~24h) and flushed on reconnect. |

A device shows Offline if it hasn't pushed within ~90s; with a 60s interval that
tolerates one missed beacon. Override the window on the hub with
`DEVICE_ONLINE_WINDOW_SECONDS` if needed.
