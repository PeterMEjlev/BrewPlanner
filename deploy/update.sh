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

echo "==> BrewPlanner update in: $REPO_DIR"

echo "==> git pull (fast-forward only)"
git pull --ff-only

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
sudo systemctl daemon-reload

# Ensure the transparent cursor theme exists (the kiosk unit references it via
# XCURSOR_THEME to hide cage's static centre-screen pointer).
echo "==> ensuring transparent cursor theme"
bash "$SCRIPT_DIR/install-transparent-cursor.sh"

echo "==> restarting services"
sudo systemctl restart checklist-server.service
sudo systemctl restart checklist-kiosk.service

echo "==> done. Now on commit:"
git --no-pager log -1 --oneline

echo "==> checklist-server status:"
sleep 1
systemctl --no-pager status checklist-server.service | head -n 8
