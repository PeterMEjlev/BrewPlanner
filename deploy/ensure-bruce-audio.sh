#!/usr/bin/env bash
#
# Make sure Bruce can actually make a sound on this Pi.
#
# The `speaker` npm module compiles a bundled slice of mpg123, whose build needs
# a per-platform config.h shipped under deps/mpg123/config/<os>/<arch>/. Upstream
# ships linux/arm, linux/ia32 and linux/x64 — but NOT linux/arm64, so on 64-bit
# Raspberry Pi OS the build dies with "config.h: No such file or directory". The
# x64 config is the correct base for aarch64 (64-bit type sizes, and the only
# target built here is the ALSA output layer, which has no CPU-specific code).
#
# `speaker` is an optionalDependency, so this failure is SILENT: npm install
# succeeds and Bruce simply can't speak. Hence this script — idempotent, and
# safe to run on every deploy (update.sh calls it, ignoring failures).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SPEAKER_DIR="$REPO_DIR/node_modules/speaker"

# Nothing to do where Bruce isn't installed, or on a non-Linux dev machine.
[ -d "$SPEAKER_DIR" ] || { echo "    (speaker module not installed — skipping)"; exit 0; }
[ "$(uname -s)" = "Linux" ] || exit 0

if [ -f "$SPEAKER_DIR/build/Release/binding.node" ]; then
  exit 0   # already built
fi

CONFIG_DIR="$SPEAKER_DIR/deps/mpg123/config/linux"
ARCH="$(uname -m)"
if [ "$ARCH" = "aarch64" ] && [ ! -d "$CONFIG_DIR/arm64" ] && [ -d "$CONFIG_DIR/x64" ]; then
  echo "    adding the arm64 mpg123 config the speaker module doesn't ship"
  cp -r "$CONFIG_DIR/x64" "$CONFIG_DIR/arm64"
fi

# Use the node-gyp npm already ships. `npx node-gyp` resolves to a newer release
# that does not run on the Pi's Node 20.
NODE_GYP=/usr/share/nodejs/node-gyp/bin/node-gyp.js
if [ ! -f "$NODE_GYP" ]; then
  echo "    (node-gyp not found at $NODE_GYP — skipping speaker build)"
  exit 0
fi

echo "    building the speaker native module (needs libasound2-dev)"
cd "$SPEAKER_DIR"
node "$NODE_GYP" rebuild >/dev/null

[ -f "$SPEAKER_DIR/build/Release/binding.node" ] && echo "    speaker built OK"
