# Quickstart

Two things you'll do often: run the app on your laptop to test, and push an
update to the Raspberry Pi.

## Run locally (laptop)

```bash
npm install        # first time only
npm run dev
```

`npm run dev` builds the shared package, then starts the API (port 3000) and the
Vite dev server (port 5173) together. Open:

- Admin:   http://localhost:5173/admin
- Display: http://localhost:5173/display
- Hub:     http://localhost:5173/

Localhost is trusted, so no login is needed in dev. The SQLite file is created
automatically at `apps/server/data/checklist.sqlite`.

Optional sanity check before deploying:

```bash
npm run typecheck
npm run build      # same build the Pi runs
```

## Deploy to the Pi (over SSH)

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
