- ## Look for security issues

- ## Add support for
  - Electricity (Watt) usage
  - Water usage 
  - Temperature of fermentor (another Inkbird 308)
  - Temperature of brewery (another Inkbird 308)
  - Gravity of beer/wort fermentation (Tilt gravity sensor.) Tilt broadcasts BLE/iBeacon data.



- ## Enable Keg inventory editing: 
  On the Raspberry Pi (production — the real deployment):
  
  The server runs as the checklist-server systemd unit, which reads secrets from /etc/brewplanner.env. SSH into the Pi, then:
  sudo nano /etc/brewplanner.env

  Add this line, save (Ctrl+O, Enter, Ctrl+X):
    KEG_SHEET_WRITE_URL=https://script.google.com/macros/s/AKfycbxKTibop5YCnFjuewJLn-cf0MJ-o2SFVVqMzHm3BK-bp7fWmT9bECyZF5NF5uw4A-ywtA/exec

  Then restart the server:
    sudo systemctl restart checklist-server.service


- ## Incorporate the readings from the TILT hydrometer to log to brewersfriend. "The Tilt wireless hydrometer operates on bluetooth. Log readings from the phone app or using a Raspberry pi with this Cloud URL. Turn on Tilt integration in your brew session under the Fermentation tab to start collecting temperature and gravity readings. 
  Cloud URL: https://log.brewersfriend.com/tilt/5a2c07e701f38d2c83ff2289df53f598c927129f" 

- ## Implement Brew System control. 


- ## FIX: "Update now" button fails — `sudo: a password is required`
  The Software Update button shells out to `sudo -n systemctl start --no-block
  brewplanner-update.service` (see [update.ts:123](apps/server/src/system/update.ts#L123)).
  The `-n` means non-interactive: it failed because the `brewplanner` service
  account has **no passwordless-sudo (NOPASSWD) rule** for that command, so sudo
  asks for a password and `-n` aborts. The version showing `a4d64dc` is just the
  last *manual* `deploy/update.sh` run — the button has never actually worked over
  sudo. The one-time install of the unit + sudoers file was skipped.

  **When you're back at the Pi (over SSH/LAN):**
  ```bash
  cd /home/brewplanner/checklist
  git pull

  # 1. Install the one-shot updater unit (if not already there)
  sudo cp deploy/brewplanner-update.service /etc/systemd/system/
  sudo systemctl daemon-reload

  # 2. Does brewplanner already have passwordless sudo?
  sudo -u brewplanner sudo -n true 2>/dev/null \
    && echo "yes — skip the sudoers file" \
    || echo "no — install the sudoers file (next step)"

  # 3. If "no": install the NOPASSWD rule (validate it — a typo can lock out sudo)
  sudo cp deploy/brewplanner-deploy.sudoers /etc/sudoers.d/brewplanner-deploy
  sudo chmod 0440 /etc/sudoers.d/brewplanner-deploy
  sudo visudo -cf /etc/sudoers.d/brewplanner-deploy   # must print "parsed OK"

  # 4. Verify the exact command the server runs is now allowed without a password
  sudo -u brewplanner sudo -n systemctl start --no-block brewplanner-update.service
  ```
  Gotcha: sudoers matches the command path exactly. The rule in
  [brewplanner-deploy.sudoers](deploy/brewplanner-deploy.sudoers) hard-codes
  `/usr/bin/systemctl`. Confirm with `command -v systemctl` — if it's not
  `/usr/bin/systemctl`, edit the alias paths to match or the rule won't apply.
  After this, the dashboard **Update now** button should work; no further changes
  needed.


