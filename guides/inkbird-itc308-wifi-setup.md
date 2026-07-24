# Joining an Inkbird ITC-308-WIFI to BrewPlanner

A start-to-finish playbook for getting an **Inkbird ITC-308-WIFI** fridge/heater
controller logging temperature into BrewPlanner. It covers the **physical**
setup (what to plug in where) and **every command** you'll run, in order, so the
day you decide to do this it's a smooth ~30–45 minute job.

When it's done you get a device tile on the dashboard showing live
fermentation **temperature**, the controller's **setpoint**, and whether it's
**cooling / idle / heating** — plus history charts. You can also push setpoint
changes *back* to the controller from the dashboard.

> This guide is the friendly walkthrough. The terse reference lives in
> [../deploy/agents/inkbird-agent/README.md](../deploy/agents/inkbird-agent/README.md);
> the big-picture roadmap is in [../SENSORS.md](../SENSORS.md).

---

## How it fits together

```
[ITC-308-WIFI] <--LAN, tinytuya--> [satellite Pi: inkbird-agent] --POST /api/ingest--> [hub Pi] --> dashboard
   (the plug)        local key            agent.py                   Bearer device key     checklist01.local
```

- **Hub** = the Pi already running BrewPlanner (`checklist01.local:3000`).
- **Satellite** = a Pi running the little `inkbird-agent` script. It can be a
  **separate** Pi on the brewery LAN, *or the same hub Pi* — your choice. The
  only requirement is that it's on the **same network** as the Inkbird.
- The Inkbird is a **Tuya** device under the hood. The agent talks to it
  **locally** over the LAN (no cloud once set up), but to do that it needs a
  one-time **local key** that you extract by linking your Inkbird app to a free
  Tuya developer account.

### What you need before you start

- [ ] The ITC-308-**WIFI** model (not the plain ITC-308, which has no network).
- [ ] Your 2.4 GHz Wi-Fi name + password (the Inkbird does **not** do 5 GHz).
- [ ] The **Inkbird** app (or InkbirdPro) installed on your phone, with the
      controller already added to it. (If not, do the physical + app steps below first.)
- [ ] A free **Tuya IoT** developer account (you'll create it in step 3).
- [ ] SSH access to the hub Pi, and to the satellite Pi if it's a separate one.

---

## Part A — Physical / real-world setup

You can skip this whole part if the controller is already wired up, on Wi-Fi,
and visible in the Inkbird phone app.

### 1. Wire up the controller

1. **Mount it** somewhere dry near the fermenter, where you can read the display
   and it won't get splashed. The ITC-308 is not waterproof.
2. **Plug the fridge into the COOLING socket** and the **heater (heat belt/pad)
   into the HEATING socket** on the controller. Getting these swapped is the
   classic mistake — cooling on the left, heating on the right (match the icons).
3. **Place the probe**: tape the temperature probe to the side of the fermenter
   and insulate it with a bit of foam, *or* drop it into a thermowell. Taping to
   the vessel reads the beer better than dangling it in air.
4. Plug the controller into mains. The display should light up.

> ⚠️ Don't rely on software the first time. Set a sane setpoint on the unit
> itself and confirm the fridge actually kicks in (cooling) and the heater warms
> (heating) **before** trusting it with a real fermentation.

### 2. Get it on Wi-Fi (via the Inkbird app)

1. Install **Inkbird** (or **InkbirdPro**) from the App Store / Play Store.
2. Create an account / log in. **Remember which email + region you use** — you'll
   link this exact account to Tuya in step 3.
3. Add the device: tap **+**, pick the ITC-308-WIFI, and follow the pairing flow
   (usually hold the Wi-Fi button on the unit until it blinks, then enter your
   **2.4 GHz** Wi-Fi credentials in the app).
4. Once it shows live temperature in the app, it's on your LAN. 

### 3. Pin its IP address (recommended)

The agent talks to the Inkbird by IP, so you don't want that IP to change on a
reboot. In your **router's admin page**, find the Inkbird in the DHCP client
list and set a **DHCP reservation** (static lease) for its MAC address. Note the
IP — you'll use it later (e.g. `192.168.1.50`).

---

## Part B — Register the device on the hub

This mints the credential the agent uses to push readings.

**SSH into the hub Pi** and, from the project directory, run:

```bash
cd /home/brewplanner/checklist        # wherever BrewPlanner is checked out
npm run device -- add "Fermenter Controller" brew_controller
```

This prints a **device key** that starts with `bp_…`, **once**. Copy it
somewhere safe right now — it is not recoverable.

- Lost it later? `npm run device -- rotate "Fermenter Controller"` issues a new
  one (the old one stops working).
- `npm run device -- list` shows every device and when it was last seen.

> Doing the **brewery ambient** thermometer too? It's just another ITC-308, so
> repeat with a different name — `npm run device -- add "Brewery Ambient" brew_controller`
> — and run a second agent instance later (same script, its own env file).

---

## Part C — Get the Inkbird's local key (one-time)

Local reads need three values: the controller's **device id**, **LAN IP**, and
**local key**. The local key is only obtainable by linking your Inkbird account
to a free Tuya developer project once. `tinytuya`'s wizard automates it.

You can run this on **any** machine (your laptop is fine) — you only need the
values it prints, then you copy them into the agent config.

```bash
pip3 install tinytuya
python3 -m tinytuya wizard
```

The wizard walks you through:

1. Create a free account at **iot.tuya.com** → create a **Cloud project**
   (pick the data centre region that matches where your Inkbird app account is).
2. In the project, **Link Tuya App Account** → scan the QR code with the
   **Inkbird app** (Me → the scan icon). This links your devices to the project.
3. Back in the terminal, the wizard pulls your devices and writes a
   **`devices.json`** file listing each device's `id`, `ip`, `key` (the local
   key), and `version`.

Find the **ITC-308-WIFI** entry and note these four values:

| From `devices.json` | Goes into env as     |
| ------------------- | -------------------- |
| `id`                | `INKBIRD_DEVICE_ID`  |
| `ip`                | `INKBIRD_IP`         |
| `key`               | `INKBIRD_LOCAL_KEY`  |
| `version`           | `INKBIRD_VERSION` (usually `3.4`) |

> If the wizard didn't capture the IP, get it from your router's DHCP table (you
> reserved it in A.3) or run `python3 -m tinytuya scan`.
>
> The Inkbird and Tuya "Smart Life" apps share the same backend, so the
> controller appears here as long as it's in the Inkbird app.

---

## Part D — Put the agent on the satellite Pi

> Same-Pi setup? If the satellite **is** the hub Pi, the repo is already there —
> skip the copy, just `pip3 install tinytuya` and continue.

1. **Copy the repo** to the satellite Pi so the agent lives at
   `/home/pi/checklist/deploy/agents/inkbird-agent/`. (Only this folder is used;
   you don't need to build the whole app there.) Easiest is `git clone` of your
   repo, or `scp -r` the project over.

2. **Install the one dependency** for live reads:

   ```bash
   pip3 install tinytuya
   ```

---

## Part E — Configure the agent

Create the env file (root-only readable, so the key isn't world-visible) using
[../deploy/agents/inkbird-agent/inkbird-agent.env.example](../deploy/agents/inkbird-agent/inkbird-agent.env.example)
as your guide:

```bash
sudo install -m 600 /dev/null /etc/inkbird-agent.env
sudo nano /etc/inkbird-agent.env
```

Fill in:

```ini
HUB_URL=http://checklist01.local:3000      # the hub Pi's address
DEVICE_KEY=bp_xxxxxxxxxxxx                  # the key from Part B
INTERVAL=30                                 # keep >=30 (see the Err 914 note)

INKBIRD_DEVICE_ID=...                       # from Part C
INKBIRD_IP=192.168.1.50                     # from Part C
INKBIRD_LOCAL_KEY=...                       # from Part C — treat like a password
INKBIRD_VERSION=3.4                         # try 3.3 only if reads fail

BP_SIMULATE=1                               # leave 1 for the first smoke-test
BP_ALLOW_SETPOINT_WRITE=1                   # 0 = read-only (dashboard can't change setpoint)
```

Save and exit (`Ctrl+O`, Enter, `Ctrl+X`).

---

## Part F — Smoke-test (still simulated)

This proves the agent → hub → dashboard pipeline works **before** you depend on
the real hardware reads.

```bash
set -a; . /etc/inkbird-agent.env; set +a
python3 /home/pi/checklist/deploy/agents/inkbird-agent/agent.py
```

You should see `starting: …` and then it goes quiet (it pushes silently on
success). On the hub dashboard, a **Fermenter Controller** tile should appear,
go **Online**, and show `temp_c` drifting around 18 °C with the relay pill
cycling Cooling / Idle / Heating. Open the tile to see the charts. `Ctrl-C` to stop.

If the tile never appears, jump to **Troubleshooting** below.

---

## Part G — Go live (real reads)

1. Edit the env again and flip the switch:

   ```bash
   sudo nano /etc/inkbird-agent.env
   # set BP_SIMULATE=0
   ```

2. Run it by hand once more:

   ```bash
   set -a; . /etc/inkbird-agent.env; set +a
   python3 /home/pi/checklist/deploy/agents/inkbird-agent/agent.py
   ```

   The dashboard values should now **match the controller's own display**
   (temperature and setpoint within rounding; the relay pill flips with the
   fridge/heater). `Ctrl-C` to stop.

---

## Part H — Run it as a service (survives reboots)

```bash
cd /home/pi/checklist/deploy/agents/inkbird-agent
sudo cp inkbird-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now inkbird-agent.service
journalctl -u inkbird-agent.service -f      # watch the logs; Ctrl-C to stop watching
```

> The shipped unit runs as user `pi` and expects the agent at
> `/home/pi/checklist/...`. If your satellite uses a different user or path, edit
> the `User=` and `ExecStart=` lines in the `.service` file before copying it.

Done. The controller now reports continuously, and the push doubles as a
heartbeat (the tile goes Offline if nothing arrives for ~90s).

---

## Changing the setpoint from the dashboard

With `BP_ALLOW_SETPOINT_WRITE=1`, the fermenter/brewery temperature page has a
setpoint control. Applying it queues a command on the hub; the agent picks it up
on its next cycle (within `INTERVAL` seconds), writes it to the controller, and
acks it. The dashboard shows "Setting to N°…" until the controller's own reading
confirms the change. Set it to `0` to keep the agent strictly read-only.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| ------- | ------------------ |
| Tile never appears, or stays **Offline** | The push isn't landing. Check `journalctl -u inkbird-agent -f`, confirm `HUB_URL` is reachable from the satellite (`curl http://checklist01.local:3000/api/active`). |
| Logs show **`push rejected: HTTP 401`** | Bad/empty `DEVICE_KEY`. Re-issue with `npm run device -- rotate "Fermenter Controller"` on the hub and update the env. |
| Live reads fail with a **decode/key error every time** | Wrong protocol version — try `INKBIRD_VERSION=3.3`. Or the local key is stale (re-run the tinytuya wizard). |
| Reads start failing after a while (**"Err 914"**) | The ITC-308-WIFI drops frequent pollers. Keep `INTERVAL` ≥ 30 (the default). Power-cycle the controller to clear a stuck lock-up. |
| Temperature looks wrong by a constant offset | The agent always reports °C, converting if the controller is set to °F — that part's automatic. Check the **probe placement** (taped vs. dangling). |
| Hub was briefly down | No action needed — readings are buffered in memory (~12h) and flushed on reconnect. |

A device shows Offline only after it has missed several reads in a row — the hub
tolerates `DEVICE_ONLINE_MISS_CYCLES` (default 3) missed reporting cycles, floored
at `DEVICE_ONLINE_WINDOW_SECONDS` (default 90s). Raise `DEVICE_ONLINE_MISS_CYCLES`
if the controller's Tuya reads are flaky enough that the tile still flickers.
