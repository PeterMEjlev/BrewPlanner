# Raspberry Pi deployment

Turn a Raspberry Pi 5 + Touch Display 2 into a dedicated checklist appliance
that boots straight into the `/display` page in fullscreen — no desktop.

## 1. Base OS

Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In the
imager's advanced options, set:

- Hostname: `checklist01` → the Pi is reachable at `checklist01.local`
- Enable SSH, set the `pi` user, configure Wi-Fi if not using Ethernet.

If you didn't set the hostname in the imager, do it on the device:

```bash
sudo raspi-config nonint do_hostname checklist01
sudo reboot
```

`checklist01.local` resolves via mDNS (Avahi), which is preinstalled on
Raspberry Pi OS. From any PC on the same LAN you can then open
`http://checklist01.local:3000/admin`.

## 2. Install runtime dependencies

```bash
sudo apt update
sudo apt install -y nodejs npm git curl cage chromium-browser
node --version   # needs Node 20+. If apt's Node is too old, use nodesource:
#   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
#   sudo apt install -y nodejs
```

- `cage` is a tiny Wayland kiosk compositor that runs a single fullscreen app
  on the display with no desktop environment.
- `chromium-browser` is the kiosk browser.

> better-sqlite3 ships prebuilt binaries for arm64, so `npm install` normally
> needs no compiler. If it falls back to building from source, also install
> `python3 make g++`.

## 3. Get the code and build

```bash
cd /home/pi
git clone <your-repo-url> checklist   # or copy the project folder here
cd checklist
npm install
npm run build            # builds shared, web, and server
npm run db:migrate       # creates data/checklist.sqlite and applies migrations
```

Quick manual smoke test before wiring up services:

```bash
DATABASE_PATH=/home/pi/checklist/data/checklist.sqlite node apps/server/dist/index.js
# open http://checklist01.local:3000/admin from your PC, then Ctrl-C
```

## 4. Install the systemd services

```bash
sudo cp deploy/checklist-server.service /etc/systemd/system/
sudo cp deploy/checklist-kiosk.service  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now checklist-server.service
sudo systemctl enable --now checklist-kiosk.service
```

Check status / logs:

```bash
systemctl status checklist-server.service
journalctl -u checklist-server.service -f
journalctl -u checklist-kiosk.service -f
```

The `checklist-server` unit serves both the API and the built web app on port
3000. The `checklist-kiosk` unit waits for the server to answer, then launches
Chromium fullscreen on `http://localhost:3000/display`.

## 5. Updating the app

```bash
cd /home/pi/checklist
git pull
npm install
npm run build
npm run db:migrate
sudo systemctl restart checklist-server.service
sudo systemctl restart checklist-kiosk.service
```

The database lives in `data/` (set via `DATABASE_PATH`) and is **not** touched
by rebuilds, so progress and checklists survive updates and reboots.

## Notes / troubleshooting

- **Blank screen / no display**: ensure the `pi` user owns the seat. `cage`
  needs `XDG_RUNTIME_DIR=/run/user/1000`; confirm the uid with `id -u pi`
  (adjust the unit if it isn't 1000).
- **Screen blanking**: to stop the display sleeping, you can add
  `--disable-features=...` is not enough; configure console blanking with
  `sudo raspi-config` → Display Options → Screen Blanking → Off.
- **Touch not working**: the Touch Display 2 is supported out of the box on a
  current Raspberry Pi OS; make sure the OS is fully updated (`sudo apt
  full-upgrade`).
- **Rotate the display**: add `video=...` / `display_rotate` settings per the
  official Touch Display 2 docs if mounting in portrait.
