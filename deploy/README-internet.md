# Exposing BrewPlanner to the internet (Cloudflare Tunnel + login)

This makes BrewPlanner reachable from any network at a domain you control
(e.g. `https://brew.example.com`), protected by a login — while the Pi's own
touchscreen keeps working with no login.

How it fits together:

```
  Phone on cellular ──HTTPS──▶ Cloudflare ──encrypted tunnel──▶ cloudflared (Pi) ──HTTP──▶ localhost:3000
                                                                                              │
  Pi touchscreen / LAN PC ─────────────────HTTP, direct──────────────────────────────────────┘
```

- **Remote visitors** come through Cloudflare. Those requests carry a
  `CF-Connecting-IP` header, so the server requires a login for them.
- **The Pi kiosk and LAN devices** hit `localhost:3000` / `checklist01.local`
  directly. The server treats private/loopback requests **without** Cloudflare
  headers as trusted and skips the login. (Set `TRUST_LOCAL=false` to require a
  login everywhere instead.)

No router port-forwarding is needed and your home IP is never exposed — the
tunnel dials *out* to Cloudflare.

---

## Prerequisites

1. A domain managed in **Cloudflare** (free plan is fine). Add the site to your
   Cloudflare account and point its nameservers at Cloudflare if you haven't.
2. BrewPlanner already built and running as a service on the Pi — see
   [README-pi.md](README-pi.md).

## 1. Set up the login (server side)

The server seeds an `admin` account on first boot. Provide its password via
`/etc/brewplanner.env` (recommended) so it isn't a random generated one:

```bash
sudo cp deploy/brewplanner.env.example /etc/brewplanner.env
sudo nano /etc/brewplanner.env       # set SESSION_SECRET and ADMIN_PASSWORD
sudo chmod 600 /etc/brewplanner.env
sudo systemctl restart checklist-server.service
```

- `SESSION_SECRET` — `openssl rand -base64 48`. Signs session cookies.
- `ADMIN_PASSWORD` — your login password.

If the database already has users, change a password any time with:

```bash
cd /home/pi/checklist
npm run user -- admin 'your-new-password'
```

## 2. Install cloudflared

```bash
# arm64 (Raspberry Pi OS 64-bit):
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
  -o /usr/local/bin/cloudflared && sudo chmod +x /usr/local/bin/cloudflared
cloudflared --version
```

## 3. Create and route the tunnel

```bash
cloudflared tunnel login                 # opens a browser; pick your domain
cloudflared tunnel create brewplanner    # writes ~/.cloudflared/<TUNNEL_ID>.json
cloudflared tunnel route dns brewplanner brew.example.com   # your hostname
```

Note the printed **TUNNEL_ID**.

## 4. Configure and run the tunnel

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<TUNNEL_ID>.json /etc/cloudflared/
sudo cp deploy/cloudflared-config.example.yml /etc/cloudflared/config.yml
sudo nano /etc/cloudflared/config.yml    # set tunnel ID, credentials path, hostname
```

Install the tunnel as a service so it starts on boot:

```bash
sudo cp deploy/cloudflared.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared.service
systemctl status cloudflared.service
```

## 5. Try it

From your phone on cellular (off your home Wi-Fi), open
`https://brew.example.com/admin`. You should get the login page; sign in with
the admin credentials. The Pi's touchscreen should still load `/display`
directly with no login.

---

## 6. Deploying updates remotely (the dashboard button)

Once the tunnel is up, you can deploy new versions from anywhere — no SSH —
using **Settings → Maintenance → Software update → Update now**. The button pulls
the latest pushed commit, rebuilds, migrates, and restarts the services on the
Pi. It's admin-only and only reachable through the authenticated tunnel.

It works by starting a **one-shot systemd unit** (`brewplanner-update.service`)
that runs `deploy/update.sh` independently of `checklist-server`, so the update
survives the server restarting itself. The script writes a status file + log
into the data dir that the dashboard polls to show progress.

**One-time install on the Pi** (do this while you can still reach it — e.g. on
your LAN — so the button works after the Pi moves). The button can't install
itself, so the very first deploy is manual:

```bash
cd /home/brewplanner/checklist
git pull                                              # get the commit with the unit + script

sudo cp deploy/brewplanner-update.service /etc/systemd/system/
sudo systemctl daemon-reload

# Does the service account already have passwordless sudo?
sudo -n true 2>/dev/null && echo "yes — skip the sudoers file" || echo "no — install the sudoers file"
# If it said "no":
sudo cp deploy/brewplanner-deploy.sudoers /etc/sudoers.d/brewplanner-deploy
sudo chmod 0440 /etc/sudoers.d/brewplanner-deploy
sudo visudo -cf /etc/sudoers.d/brewplanner-deploy     # must print "parsed OK"

deploy/update.sh                                       # build + restart once, with the new code
```

After that, the workflow from either computer is: **commit and `git push`**, then
open the dashboard and click **Update now**. The dashboard goes unavailable for a
few seconds while the server restarts, then confirms the new version.

> Heads-up: the button deploys whatever is on the repo's remote `main`. It's
> gated to admins behind the tunnel login (add Cloudflare Access for a second
> factor), but treat that login like SSH access.

## Hardening (optional but recommended)

- **Cloudflare Access** — put an extra identity layer (email one-time PIN,
  Google, etc.) *in front of* the app in the Cloudflare dashboard
  (Zero Trust → Access → Applications). Then only approved identities ever
  reach the login page at all.
- **WAF / rate limiting** — Cloudflare's dashboard can rate-limit
  `/api/auth/login` to blunt brute-force attempts.
- Keep `COOKIE_SECURE=true` and `NODE_ENV=production` (already set in the
  server service) so session cookies are only sent over HTTPS.

## Troubleshooting

- **Login page works locally but not remotely**: check
  `systemctl status cloudflared` and `journalctl -u cloudflared -f`. Confirm the
  DNS record exists (`cloudflared tunnel route dns` step) and the hostname in
  `config.yml` matches.
- **Remote shows the app without asking for login**: the server isn't seeing
  Cloudflare headers — confirm traffic actually goes through the tunnel (not a
  port-forward) and that you're hitting the Cloudflare hostname, not the LAN IP.
- **Locked out of the kiosk**: the kiosk uses `http://localhost:3000/display`,
  which is always trusted; if it ever prompts for login, verify `TRUST_LOCAL`
  is not set to `false`.
