#!/usr/bin/env bash
#
# Install a fully transparent Wayland cursor theme so the cage kiosk shows NO
# mouse pointer. cage/wlroots draws a default arrow in the centre of the screen
# on startup; the Pi has only a touchscreen (no mouse) so nothing ever moves or
# hides it, and because it is the COMPOSITOR's cursor, page CSS cannot remove it.
# The kiosk unit sets XCURSOR_THEME=transparent so wlroots loads this theme and
# draws its (transparent) default cursor instead — i.e. nothing.
#
# Idempotent; safe to re-run. Invoked automatically by deploy/update.sh.
set -euo pipefail

THEME_DIR=/usr/share/icons/transparent

# Idempotent fast path — and the reason this no longer breaks deploys.
#
# This is a ONE-TIME system install that lives under /usr/share and persists
# across rebuilds, restarts and reboots. The web "Update" button runs the whole
# deploy as the non-root `brewplanner` user with NO TTY, so any `sudo` below
# would need a password it can't supply and the deploy would abort. Once the
# theme exists we therefore do nothing at all — crucially invoking no `sudo` —
# so the cosmetic cursor step can never again fail a code update.
if [ -f "$THEME_DIR/index.theme" ] && [ -f "$THEME_DIR/cursors/left_ptr" ]; then
  echo "Transparent cursor theme already present at $THEME_DIR — nothing to do."
  exit 0
fi

# A fresh install genuinely needs root. If we have no terminal to prompt on AND
# no passwordless sudo (i.e. we're inside the web updater), bail out with a clear
# message instead of the cryptic "sudo: a terminal is required…". This is a
# provisioning step: run this script once interactively during Pi setup. The
# caller (update.sh) treats a non-zero exit here as a non-fatal warning.
if [ ! -t 0 ] && ! sudo -n true 2>/dev/null; then
  echo "Transparent cursor theme not installed yet, and no TTY / passwordless sudo" >&2
  echo "to install it now. Run once during setup:  bash $0" >&2
  exit 1
fi

sudo mkdir -p "$THEME_DIR/cursors"
printf '[Icon Theme]\nName=transparent\n' | sudo tee "$THEME_DIR/index.theme" >/dev/null

# Emit a 1x1 fully transparent cursor in the Xcursor binary format. Writing the
# bytes directly avoids depending on xcursorgen (not installed on the Lite OS).
python3 - <<'PY' | sudo tee "$THEME_DIR/cursors/left_ptr" >/dev/null
import struct, sys

SIZE = 24                      # nominal size advertised to the theme loader
IMAGE_TYPE = 0xFFFD0002        # Xcursor image chunk type
out = b""
# File header: magic "Xcur", header length, file version 1.0, 1 table entry.
out += struct.pack("<IIII", 0x72756358, 16, 0x00010000, 1)
# Table of contents: image type, nominal size, byte offset of the chunk (28).
out += struct.pack("<III", IMAGE_TYPE, SIZE, 28)
# Image chunk header: header length 36, type, size, chunk version 1.
out += struct.pack("<IIII", 36, IMAGE_TYPE, SIZE, 1)
# width, height, xhot, yhot, delay  +  one fully transparent ARGB pixel.
out += struct.pack("<IIIII", 1, 1, 0, 0, 0)
out += struct.pack("<I", 0x00000000)
sys.stdout.buffer.write(out)
PY

# wlroots may request the default cursor under several names depending on
# version (legacy "left_ptr" vs freedesktop "default"); cover the common ones.
for name in default arrow top_left_arrow; do
  sudo cp -f "$THEME_DIR/cursors/left_ptr" "$THEME_DIR/cursors/$name"
done

echo "Transparent cursor theme installed at $THEME_DIR"
