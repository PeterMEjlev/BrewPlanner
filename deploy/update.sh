#!/usr/bin/env bash
#
# BrewPlanner one-shot updater. Run this ON THE PI to pull the latest committed
# code, rebuild, apply migrations, and restart the services.
#
#   ~/checklist/deploy/update.sh
#
# It resolves the repo root from its own location, so it works no matter where
# the repo is cloned or which directory you run it from. If you are not already
# on the Pi, SSH in FIRST (do not paste the ssh line into a Pi shell):
#
#   ssh brewplanner@BrewPlanner
#   ~/checklist/deploy/update.sh
#
set -euo pipefail

# Repo root = parent of this script's deploy/ directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
cd "$REPO_DIR"

# --- Progress reporting ------------------------------------------------------
# The dashboard's "Update" button launches this script via a one-shot systemd
# unit, then polls a status file + log to show progress and to confirm the
# deploy AFTER the server restarts itself below. These live in the data dir,
# which sits outside the build tree and survives rebuilds (same dir as the DB).
DATA_DIR="$(dirname "${DATABASE_PATH:-$REPO_DIR/data/checklist.sqlite}")"
mkdir -p "$DATA_DIR"
STATUS_FILE="$DATA_DIR/update-status.json"
LOG_FILE="$DATA_DIR/last-update.log"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Mirror all output to the log file (truncated each run) as well as the journal.
exec > >(tee "$LOG_FILE") 2>&1

# Minimal JSON string escaping: backslashes, double quotes, control chars.
json_escape() { printf '%s' "${1:-}" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\000-\037'; }

write_status() {
  # $1 = state (running|ok|failed); $2 = optional error message.
  local state="$1" err finished commit subject
  err="$(json_escape "${2:-}")"
  finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  subject="$(json_escape "$(git --no-pager log -1 --pretty=%s 2>/dev/null || true)")"
  if [ "$state" = "running" ]; then
    printf '{"state":"running","startedAt":"%s"}\n' "$STARTED_AT" > "$STATUS_FILE"
  else
    printf '{"state":"%s","startedAt":"%s","finishedAt":"%s","commit":"%s","commitSubject":"%s","error":"%s"}\n' \
      "$state" "$STARTED_AT" "$finished" "$commit" "$subject" "$err" > "$STATUS_FILE"
  fi
}

# On any exit, record success/failure for the dashboard. `set -e` makes a failed
# step jump straight here with a non-zero code.
on_exit() {
  local code=$?
  if [ "$code" -eq 0 ]; then
    write_status ok
  else
    write_status failed "update.sh exited with code $code — see the log."
  fi
}
trap on_exit EXIT

write_status running

echo "==> BrewPlanner update in: $REPO_DIR"

echo "==> git fetch"
git fetch

# Nothing under the repo on the Pi is authored there — it is a deploy checkout,
# not a workspace. But files do get pasted in by hand (a knowledge doc, a config
# scratch copy), and if a later commit adds that same path, git refuses to
# overwrite the untracked copy and the ENTIRE deploy aborts before the build.
# So: move any untracked file that the incoming commits would clobber into a
# timestamped backup beside the DB, then let the fast-forward proceed.
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [ -n "$UPSTREAM" ]; then
  echo "==> checking for untracked files in the way of $UPSTREAM"
  BACKUP_DIR="$DATA_DIR/update-backups/$(date -u +%Y%m%dT%H%M%SZ)"
  # Only ADDED paths can collide: a path upstream merely modifies was already
  # tracked at HEAD, so the local file there is tracked too, not untracked.
  # -z + read -d '' keeps paths with spaces/unicode intact.
  while IFS= read -r -d '' path; do
    [ -e "$path" ] || continue
    if git ls-files --error-unmatch -- "$path" >/dev/null 2>&1; then
      continue  # tracked: git handles it
    fi
    mkdir -p "$BACKUP_DIR/$(dirname "$path")"
    mv "$path" "$BACKUP_DIR/$path"
    echo "    moved untracked $path -> $BACKUP_DIR/$path"
  done < <(git diff -z --name-only --diff-filter=A --no-renames "HEAD..$UPSTREAM")

  # Same problem, tracked files: `npm install` below rewrites package-lock.json
  # in place, so the deploy checkout is dirty by the time the NEXT update runs,
  # and git refuses to fast-forward over the local change. Nothing here is
  # authored on the Pi, so local edits to tracked files are always disposable —
  # stash a copy beside the DB for forensics, then restore the file from HEAD.
  echo "==> checking for locally-modified tracked files"
  while IFS= read -r -d '' path; do
    [ -e "$path" ] || continue
    mkdir -p "$BACKUP_DIR/$(dirname "$path")"
    cp "$path" "$BACKUP_DIR/$path"
    echo "    reverting local change to $path (copy in $BACKUP_DIR/$path)"
  done < <(git diff -z --name-only HEAD)
  git checkout -- .
fi

echo "==> git merge (fast-forward only)"
if [ -n "$UPSTREAM" ]; then
  # Merge the exact ref we just scanned, rather than re-fetching and possibly
  # fast-forwarding onto commits that arrived after the check above.
  git merge --ff-only "$UPSTREAM"
else
  echo "    (no upstream configured for this branch — falling back to git pull)"
  git pull --ff-only
fi

echo "==> npm install"
npm install

echo "==> npm run build (shared -> web -> server)"
npm run build

echo "==> npm run db:migrate"
npm run db:migrate

# Re-sync the systemd units so changes committed to deploy/*.service (e.g. the
# kiosk launch URL) actually reach the installed copies under /etc.
echo "==> syncing systemd units"
sudo cp "$SCRIPT_DIR/checklist-server.service" /etc/systemd/system/
sudo cp "$SCRIPT_DIR/checklist-kiosk.service" /etc/systemd/system/
# bruce.service was added after the sudoers whitelist
# (deploy/brewplanner-deploy.sudoers) shipped, so on a Pi whose whitelist
# predates it this cp is refused. Bruce is optional — warn and keep deploying
# rather than failing the whole update.
if ! sudo -n cp "$SCRIPT_DIR/bruce.service" /etc/systemd/system/ 2>/dev/null; then
  echo "    (warning: bruce.service not synced — reinstall the sudoers whitelist:"
  echo "     sudo cp deploy/brewplanner-deploy.sudoers /etc/sudoers.d/brewplanner-deploy)"
fi
sudo systemctl daemon-reload

# Ensure the transparent cursor theme exists (the kiosk unit references it via
# XCURSOR_THEME to hide cage's static centre-screen pointer). This is a one-time,
# persistent system install, so the installer is a no-op once it's in place. It's
# also purely cosmetic — it must NEVER block a code deploy — so a non-zero exit
# (e.g. a fresh Pi where it isn't installed yet and the web updater has no sudo)
# is logged as a warning and the deploy continues. The `if !` guard keeps `set -e`
# from aborting here.
echo "==> ensuring transparent cursor theme"
if ! bash "$SCRIPT_DIR/install-transparent-cursor.sh"; then
  echo "    (warning: transparent cursor theme step skipped — cosmetic only;"
  echo "     run deploy/install-transparent-cursor.sh once during Pi setup)"
fi

echo "==> restarting services"
sudo systemctl restart checklist-server.service
sudo systemctl restart checklist-kiosk.service

# Bruce (the voice assistant) is opt-in: it only runs once the operator has
# enabled it (audio hardware + API keys, see deploy/README-bruce.md). Restart
# it only when enabled — and never let it fail the deploy (the whitelist on an
# older Pi may not cover it yet; see the unit-sync warning above).
if systemctl is-enabled --quiet bruce.service 2>/dev/null; then
  echo "==> restarting bruce.service"
  if ! sudo -n systemctl restart bruce.service 2>/dev/null; then
    echo "    (warning: bruce.service not restarted — reinstall the sudoers whitelist)"
  fi
fi

# The sensor agents run straight out of this checkout (see deploy/agents/*/), so
# a pulled change to an agent.py does nothing until its unit is restarted — the
# old process keeps polling on the old code indefinitely. Restart whichever
# agents this machine actually has installed; a satellite Pi runs this same
# script for its own. Their unit files are NOT synced from the repo the way the
# server's is: each install hand-edits paths and EnvironmentFile, so overwriting
# them would break the satellite.
#
# Never let one fail the deploy: agents are optional, and a whitelist predating
# them is refused exactly like bruce's above.
for agent in inkbird power pressure tilt water; do
  unit="$agent-agent.service"
  if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
    echo "==> restarting $unit"
    if ! sudo -n systemctl restart "$unit" 2>/dev/null; then
      echo "    (warning: $unit not restarted — reinstall the sudoers whitelist)"
    fi
  fi
done

echo "==> done. Now on commit:"
git --no-pager log -1 --oneline

echo "==> checklist-server status:"
sleep 1
systemctl --no-pager status checklist-server.service | head -n 8
