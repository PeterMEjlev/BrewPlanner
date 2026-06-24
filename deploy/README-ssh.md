# Browser SSH to the Pi (Cloudflare Tunnel + Access)

Goal: open a **full terminal on the Pi from a browser** at a domain you control
(e.g. `https://ssh.konfusbrewing.com`) so you can fully administer the system
remotely — no port-forwarding, no exposed home IP, no custom code in the app.

This reuses the **same Cloudflare Tunnel** that already serves the dashboard
(see [README-internet.md](README-internet.md)). The app and SSH are two
hostnames on one tunnel:

```
  Browser ──HTTPS──▶ Cloudflare Access ──encrypted tunnel──▶ cloudflared (Pi) ──▶ localhost:22 (sshd)
                         │
                    identity check (email OTP / Google) — only you get a terminal
```

> ⚠️ This is shell access to the Pi, where the service account has passwordless
> sudo for deploys — i.e. effectively root. The tunnel does **not** authenticate
> it; **Cloudflare Access is the lock**. Do not skip the Access application +
> policy steps, and treat the allowed identities like SSH keys.

---

## Prerequisites

1. The dashboard tunnel from [README-internet.md](README-internet.md) is already
   up (`cloudflared.service` running, `/etc/cloudflared/config.yml` in place).
2. A **Cloudflare Zero Trust** team set up (free plan is fine):
   Cloudflare dashboard → **Zero Trust** → pick a team name on first visit.

## 1. Make sure sshd is running on the Pi

```bash
sudo systemctl enable --now ssh
sudo systemctl status ssh        # should be active (running)
```

## 2. Add an SSH hostname to the tunnel

Route a new subdomain through the existing tunnel and point it at the Pi's sshd:

```bash
# Give the SSH endpoint its own DNS name on the same tunnel.
cloudflared tunnel route dns brewplanner ssh.konfusbrewing.com
```

Then add the ingress rule to `/etc/cloudflared/config.yml` (see
[cloudflared-config.example.yml](cloudflared-config.example.yml)) — it must come
**before** the `http_status:404` catch-all:

```yaml
ingress:
  - hostname: konfusbrewing.com
    service: http://localhost:3000
  - hostname: ssh.konfusbrewing.com      # ← add this block
    service: ssh://localhost:22
  - service: http_status:404
```

Reload the tunnel:

```bash
sudo systemctl restart cloudflared.service
journalctl -u cloudflared -f            # watch for the new ingress, Ctrl-C to stop
```

## 3. Put it behind a Cloudflare Access application (the lock)

In **Zero Trust → Access → Applications → Add an application → Self-hosted**:

- **Application name**: `Pi SSH`
- **Public hostname**: `ssh.konfusbrewing.com`
- Under the app's settings, find **Browser rendering** and set it to **SSH**.
  This is what makes Cloudflare draw a terminal in the browser instead of
  expecting a raw SSH client.

> The Zero Trust UI gets renamed periodically (Access ↔ "Access for
> Infrastructure"). The two things you're looking for regardless of labels are:
> a **Self-hosted application** on the `ssh.` hostname, and a **browser-rendered
> SSH** toggle. If you can't find browser rendering on your plan, jump to
> [Fallback: terminal client](#fallback-no-browser-rendering) — it still uses
> this same tunnel + Access, just from your own terminal.

## 4. Add an Access policy (who gets in)

Still in the application, add a policy:

- **Policy name**: `Just me`
- **Action**: Allow
- **Include** → **Emails** → your address (e.g. `pedeejlev@gmail.com`).

Pick a login method under **Settings → Authentication** — **One-time PIN**
(emails you a code) needs no extra setup; Google/GitHub is smoother if you'd
rather click through. Now only an approved identity ever reaches the terminal.

## 5. Try it

Open `https://ssh.konfusbrewing.com`. You should get the Cloudflare Access login
(OTP/Google), then a terminal. Log in as your Pi user (e.g. `brewplanner`) using
its password or key — see step 6 to get rid of that prompt.

---

## 6. Recommended: short-lived certificates (no passwords)

So you're not relying on SSH password auth being enabled, let Cloudflare mint a
**short-lived certificate** per session that the Pi trusts. Then you can turn
password auth off entirely.

1. In Zero Trust → **Access → Service Auth → SSH** (a.k.a. "SSH" /
   "Short-lived certificates"), generate a certificate for the
   `ssh.konfusbrewing.com` application and copy the **public key**.
2. On the Pi, trust that CA and map the cert's principal to your login user:

   ```bash
   sudo tee /etc/ssh/cloudflare_ca.pub >/dev/null   # paste the public key, save (Ctrl-D)
   sudo tee /etc/ssh/sshd_config.d/cloudflare.conf >/dev/null <<'EOF'
   PubkeyAuthentication yes
   TrustedUserCAKeys /etc/ssh/cloudflare_ca.pub
   EOF
   sudo systemctl restart ssh
   ```

   Cloudflare issues the cert with a principal derived from your identity; the
   exact value and any `AuthorizedPrincipals` mapping are shown in the Cloudflare
   SSH docs for your account — follow those for the principal ↔ Pi-username link.
3. Once browser logins work via the cert, harden sshd by disabling password
   auth (`PasswordAuthentication no` in the same drop-in, then restart ssh).

---

## Security notes

- **Access is the only thing protecting a root-capable shell.** Keep the policy
  tight (your identities only), and consider requiring an Access **session
  duration** short enough that a forgotten browser tab can't be reused.
- Cloudflare Access logs every SSH session under **Zero Trust → Logs →
  Access**; with short-lived certs you also get per-command auditing. Leave it on.
- The Pi kiosk and LAN are unaffected — this only adds a remote door; it doesn't
  change the app's own trusted-local behaviour.
- To revoke remote SSH entirely, delete the `ssh.` ingress rule (step 2) and
  restart `cloudflared`, or disable/delete the Access application. Either alone
  closes the door.

## Fallback: no browser rendering

If browser-rendered SSH isn't available, you still get tunnelled, Access-gated
SSH from a normal terminal on any machine that has `cloudflared` installed:

```bash
# One-time SSH config so `ssh` knows to proxy through Access:
#   Host ssh.konfusbrewing.com
#     ProxyCommand cloudflared access ssh --hostname %h
ssh brewplanner@ssh.konfusbrewing.com     # opens the Access login in a browser, then connects
```

This is also the better choice when you want `scp`/`rsync` or to drive the Pi
from an editor rather than a web terminal.

## Troubleshooting

- **Browser shows the terminal but login fails**: confirm `ssh` is running on
  the Pi (`systemctl status ssh`) and that you're using a real Pi username; with
  short-lived certs, verify the principal mapping (step 6).
- **`502`/`Bad Gateway`**: the ingress points somewhere sshd isn't — check the
  `ssh://localhost:22` rule and `journalctl -u cloudflared -f`.
- **No Access prompt (it goes straight through)**: the Access application's
  hostname doesn't match `ssh.konfusbrewing.com` exactly, so nothing is gating
  it — fix the hostname. Until then, **remove the ingress rule**; an ungated SSH
  hostname is an open shell.
