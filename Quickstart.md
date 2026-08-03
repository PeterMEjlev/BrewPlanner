# Quickstart

Two things you'll do often: run the app on your laptop to test, and push an
update to the Raspberry Pi.

## Run locally (laptop)

```bash
npm run dev
```

## Build Android .APK
```bash
npm run android:build --workspace @checklist/web

$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
.\apps\web\android\gradlew.bat assembleDebug -p apps\web\android
```

## Deploy to the Pi (over SSH) - "~/checklist/deploy/update.sh"




The Pi runs the code from a git checkout at `/home/pi/checklist`, so deploying =
push your commits, then pull + rebuild on the Pi.

**1. From your laptop — commit and push your changes:**

```bash
git push
```

**2. SSH in and update — run these on the Pi:**

```bash
ssh pi@checklist01.local

cd /home/pi/checklist
git pull
npm install                                   # only if dependencies changed
npm run build                                 # shared → web → server
npm run db:migrate                            # apply any new migrations
sudo systemctl restart checklist-server.service
sudo systemctl restart checklist-kiosk.service
```

Or as a one-liner from your laptop (no interactive shell needed):

```bash
ssh pi@checklist01.local "cd /home/pi/checklist && git pull && npm install && npm run build && npm run db:migrate && sudo systemctl restart checklist-server.service checklist-kiosk.service"
```

The database lives in `data/` and is **not** touched by rebuilds, so checklists,
to-dos, and sensor history survive every update.

**Verify it came back up:**

```bash
systemctl status checklist-server.service
journalctl -u checklist-server.service -f      # live logs, Ctrl-C to stop
```

Then open `http://checklist01.local:3000/admin` from any PC on the LAN.

---

First-time Pi setup (flashing the OS, installing the systemd services, kiosk
mode) is a one-off — see [deploy/README-pi.md](deploy/README-pi.md). For internet
exposure + login over a Cloudflare tunnel, see
[deploy/README-internet.md](deploy/README-internet.md).
