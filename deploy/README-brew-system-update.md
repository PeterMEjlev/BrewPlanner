# "Update brew system" button

Settings → Maintenance has a second update button next to the dashboard's own:
it deploys the latest pushed **brew-system-v3** commit onto the brewing rig (the
separate Pi) — `git pull`, rebuild its UI, restart `brew-system.service`.

```
Dashboard ──▶ checklist-server ──▶ deploy/update-brew-system.sh ──SSH──▶ rig
                                          │                              │
                                   status + log files            git pull, npm build,
                                   in the data dir               systemctl restart
```

The server spawns the script **detached** and returns immediately; the page polls
`/api/system/brew-system-update/status`, which reads the status JSON and log tail
the script writes next to the database. Unlike `update.sh`, this never restarts
the dashboard, so it needs no systemd unit and no sudoers rule on this Pi.

## Safety

Updating restarts the service that drives the heating elements, so it is refused
while the rig is in use. The check happens **twice**:

1. In the server, before anything starts — the error names what's on
   (`The rig is in use (HLT still on)…`).
2. In the remote script, immediately before `systemctl restart` — because the
   npm build takes a minute or two, which is plenty of time for someone to
   switch a heater on after the first check passed.

The remote half also refuses to run if the rig's working tree is dirty, rather
than pulling over local edits.

## One-time setup

The `brewplanner` service account needs an SSH key the rig trusts.

**On the BrewPlanner Pi**, as `brewplanner`:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N '' -C 'brewplanner -> brew rig deploy'
cat ~/.ssh/id_ed25519.pub
```

**On the rig**, append that public key:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo '<the ssh-ed25519 line you just printed>' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Then verify from the BrewPlanner Pi — this must succeed with no prompt:

```bash
ssh -o BatchMode=yes pi@<rig-ip> 'systemctl show brew-system.service -p WorkingDirectory --value'
```

The rig's account also needs passwordless sudo for
`systemctl restart brew-system.service`; the default `pi` user already has it.

## Configuration

Normally none. The script reuses the host from `BREW_SYSTEM_URL` (the rig the
Brew System page already talks to) with the `pi` account. Override in
`/etc/brewplanner.env` only if they differ:

```bash
BREW_SYSTEM_SSH_USER=pi              # different account
BREW_SYSTEM_SSH=pi@192.168.1.60      # different host entirely
```

## Where things land

| Path | What |
|---|---|
| `<data dir>/brew-system-update-status.json` | state, timestamps, resulting commit |
| `<data dir>/last-brew-system-update.log` | full output of the last run |

`<data dir>` is the directory holding `checklist.sqlite` (`/home/brewplanner/data`
on the Pi), so both survive a rebuild.

## Troubleshooting

- **"Permission denied (publickey)"** in the log → the key step above wasn't
  completed, or the key landed in the wrong account's `authorized_keys`.
- **Stuck on "Updating rig…"** → a run that reports nothing for 15 minutes is
  treated as dead and flips to failed; the log tail says how far it got.
- **"refusing to pull over them"** → the rig has uncommitted local edits. SSH in
  and deal with them; don't `git reset --hard` blind, that's how the rig's tuned
  `config.json` was lost once already.
- **Rig unreachable** → the button refuses rather than guessing, because it
  can't confirm the heaters are off.
