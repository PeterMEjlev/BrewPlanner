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

echo "==> restarting services"
sudo systemctl restart checklist-server.service
sudo systemctl restart checklist-kiosk.service

echo "==> done. Now on commit:"
git --no-pager log -1 --oneline

echo "==> checklist-server status:"
sleep 1
systemctl --no-pager status checklist-server.service | head -n 8
