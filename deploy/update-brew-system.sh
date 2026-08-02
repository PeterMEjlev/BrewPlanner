#!/usr/bin/env bash
#
# Update the BREWING RIG (the separate brew-system-v3 Pi) from the BrewPlanner
# Pi over SSH. Triggered by the dashboard's "Update brew system" button; see
# apps/server/src/system/brewSystemUpdate.ts, which spawns this detached and
# then polls the status file written below. Running it by hand works too:
#
#   ~/checklist/deploy/update-brew-system.sh
#
# Unlike deploy/update.sh this does NOT restart the BrewPlanner server, so it
# can run in the foreground as an ordinary child process — no systemd unit and
# no sudo needed on this side. The rig account does need passwordless sudo for
# `systemctl restart brew-system.service`, which the default `pi` user has.
#
# Setup (once): the `brewplanner` user needs an SSH key authorised on the rig.
#   ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ''
#   ssh-copy-id pi@<rig-ip>          # or append the .pub to its authorized_keys
# See deploy/README-brew-system-update.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# --- Where to reach the rig --------------------------------------------------
# BREW_SYSTEM_SSH ("user@host") wins. Otherwise reuse the host from
# BREW_SYSTEM_URL — the rig the dashboard already talks to — with the `pi`
# account, so a working Brew System page is all the config most setups need.
target="${BREW_SYSTEM_SSH:-}"
if [ -z "$target" ]; then
  host="${BREW_SYSTEM_URL:-}"
  host="${host#*://}"   # drop scheme
  host="${host%%/*}"    # drop path
  host="${host%%:*}"    # drop port
  if [ -z "$host" ]; then
    echo "Neither BREW_SYSTEM_SSH nor BREW_SYSTEM_URL is set — nothing to update." >&2
    exit 1
  fi
  target="${BREW_SYSTEM_SSH_USER:-pi}@$host"
fi

# --- Progress reporting (same shape as deploy/update.sh) ---------------------
DATA_DIR="$(dirname "${DATABASE_PATH:-$REPO_DIR/data/checklist.sqlite}")"
mkdir -p "$DATA_DIR"
STATUS_FILE="$DATA_DIR/brew-system-update-status.json"
LOG_FILE="$DATA_DIR/last-brew-system-update.log"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

exec > >(tee "$LOG_FILE") 2>&1

json_escape() { printf '%s' "${1:-}" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }

# Filled in after the run so the dashboard can show what the rig ended on.
RIG_COMMIT=""
RIG_SUBJECT=""

write_status() {
  # $1 = state (running|ok|failed); $2 = optional error message.
  local state="$1" err finished
  err="$(json_escape "${2:-}")"
  finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ "$state" = "running" ]; then
    printf '{"state":"running","startedAt":"%s"}\n' "$STARTED_AT" > "$STATUS_FILE"
  else
    printf '{"state":"%s","startedAt":"%s","finishedAt":"%s","commit":"%s","commitSubject":"%s","error":"%s"}\n' \
      "$state" "$STARTED_AT" "$finished" \
      "$(json_escape "$RIG_COMMIT")" "$(json_escape "$RIG_SUBJECT")" "$err" > "$STATUS_FILE"
  fi
}

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

read_rig_head() {
  # Best effort — a failure here must not turn a good deploy into a bad status,
  # and must not abort the EXIT trap under `set -e`. Hence the explicit
  # `return 0`: this runs from the trap, where a non-zero exit would skip the
  # status write entirely and leave the button stuck on "running".
  local line
  line="$(ssh "${SSH_OPTS[@]}" "$target" \
    'cd "$(systemctl show brew-system.service -p WorkingDirectory --value)" 2>/dev/null &&
     printf "%s\t%s" "$(git rev-parse --short HEAD)" "$(git --no-pager log -1 --pretty=%s)"' 2>/dev/null || true)"
  if [ -n "$line" ]; then
    RIG_COMMIT="${line%%$'\t'*}"
    if [ "$RIG_COMMIT" != "$line" ]; then
      RIG_SUBJECT="${line#*$'\t'}"
    fi
  fi
  if [ -z "$RIG_COMMIT" ]; then
    RIG_COMMIT="unknown"
  fi
  return 0
}

on_exit() {
  local code=$?
  read_rig_head
  if [ "$code" -eq 0 ]; then
    write_status ok
  elif [ "$code" -eq 2 ]; then
    write_status failed "The rig is mid-brew (a heater or pump is on) — update refused. Turn them off and try again."
  else
    write_status failed "Update failed with exit code $code. See the log for details."
  fi
}
trap on_exit EXIT

write_status running
echo "Updating brewing rig at $target"
echo "Started $STARTED_AT"
echo

# --- The part that runs ON THE RIG -------------------------------------------
# Piped over stdin rather than checked out on the rig, so the logic is versioned
# here (next to the button) and a rig that has never been updated still works.
# Quoted 'REMOTE' — everything below is expanded on the rig, not here.
ssh "${SSH_OPTS[@]}" "$target" 'bash -s' <<'REMOTE'
set -euo pipefail

UNIT=brew-system.service

# Ask systemd where the checkout is instead of hardcoding a path — the rig's
# repo has moved before, and the unit is the thing that has to be right anyway.
REPO="$(systemctl show "$UNIT" -p WorkingDirectory --value)"
if [ -z "$REPO" ] || [ ! -d "$REPO/.git" ]; then
  echo "Could not find the rig's git checkout via $UNIT (got '${REPO:-}')." >&2
  exit 1
fi
cd "$REPO"
echo "Repo:   $REPO"

# Refuse on a dirty tree rather than clobbering it. config.json is gitignored,
# so this should only ever trip on real local edits — which are worth a look
# before a deploy throws them away.
if [ -n "$(git status --porcelain)" ]; then
  echo "The rig has uncommitted changes — refusing to pull over them:" >&2
  git status --short >&2
  exit 1
fi

BEFORE="$(git rev-parse HEAD)"
echo "Before: $(git rev-parse --short HEAD) $(git --no-pager log -1 --pretty=%s)"
echo
git pull --ff-only
echo
AFTER="$(git rev-parse HEAD)"
echo "After:  $(git rev-parse --short HEAD) $(git --no-pager log -1 --pretty=%s)"

# Both stamps live on gitignored paths (node_modules/, dist/), so writing them
# can never dirty the tree and trip the guard above on the next run.
DEPS_STAMP=node_modules/.brewplanner-deps-stamp
BUILD_STAMP=dist/.brewplanner-build-commit

# The dependency set node_modules was last installed from. Prefer the lockfile —
# it pins the resolved tree — and fall back to package.json if there isn't one.
DEPS_MANIFEST=package-lock.json
[ -f "$DEPS_MANIFEST" ] || DEPS_MANIFEST=package.json
deps_hash() { sha256sum "$DEPS_MANIFEST" | cut -d' ' -f1; }

# dist/ is gitignored, so a fresh clone needs a build even with no new commits.
# The build stamp is what makes "no new commits" trustworthy: dist/index.html
# merely existing says nothing about which commit produced it, so a rig whose
# build had failed (or predated the last few pulls) would report "already up to
# date" and exit 0 with months-old code still running behind a green checkmark.
if [ "$BEFORE" = "$AFTER" ] && [ -f dist/index.html ] &&
   [ "$(cat "$BUILD_STAMP" 2>/dev/null || true)" = "$AFTER" ]; then
  echo
  echo "Already up to date — nothing to build, leaving the service alone."
  exit 0
fi

# npm install when the resolved dependency set differs from whatever node_modules
# was last built against (it is slow on a Pi, so not every run), or when
# node_modules is missing entirely.
#
# This deliberately does not look at what the pull changed. The commit-range test
# it replaced — install only if this pull touched package.json — went wrong for
# any dependency that landed while the rig was behind, or during a run that died
# before installing: every later pull saw an untouched manifest, skipped the
# install for good, and the build failed on a package that had been declared all
# along. Comparing against node_modules itself catches that drift however it
# happened.
if [ ! -d node_modules ] || [ ! -f "$DEPS_STAMP" ] ||
   [ "$(cat "$DEPS_STAMP")" != "$(deps_hash)" ]; then
  echo
  echo "--- npm install ---"
  npm install --no-audit --no-fund
  # Hash after installing, not before: npm rewrites the lockfile as it resolves,
  # and stamping the pre-install hash would re-trigger an install every run.
  deps_hash > "$DEPS_STAMP"
else
  echo
  echo "Dependencies already match node_modules — skipping npm install."
fi

echo
echo "--- npm run build ---"
npm run build
# Record what this dist was built from. Written after the build because vite
# empties dist/ on the way in, and only on success — `set -e` means a failed
# build never reaches here, so a broken build stays visibly stale rather than
# stamping itself as current.
printf '%s\n' "$AFTER" > "$BUILD_STAMP"

# Re-check right before restarting: the build takes a while on a Pi, and the
# rig may have been switched on in the meantime. The server checks this too,
# but this is the check that actually protects the heaters.
echo
STATE="$(curl -s -m 4 http://127.0.0.1:8000/api/hardware/state || true)"
if [ -n "$STATE" ]; then
  printf '%s' "$STATE" | python3 -c '
import json, sys
d = json.load(sys.stdin)
c = d["controlState"]
busy = [n for n, p in c["pots"].items() if p.get("heaterOn")]
busy += [n for n, p in c["pumps"].items() if p.get("on")]
if busy:
    print("ACTIVE: " + ", ".join(busy), file=sys.stderr)
    sys.exit(2)
print("Rig is idle — safe to restart.")
' || exit 2
else
  echo "Rig API not answering — it is already down, so restarting is safe."
fi

echo
echo "--- restarting $UNIT ---"
sudo -n systemctl restart "$UNIT"

# Give uvicorn a moment to bind before declaring victory, then prove it.
sleep 6
if ! systemctl is-active --quiet "$UNIT"; then
  echo "$UNIT did not come back up:" >&2
  journalctl -u "$UNIT" -n 30 --no-pager >&2
  exit 1
fi
curl -s -m 5 -o /dev/null -w 'API answered HTTP %{http_code}\n' http://127.0.0.1:8000/api/hardware/state
echo "OK — $UNIT active on $(git rev-parse --short HEAD)"
REMOTE

echo
echo "Done."
