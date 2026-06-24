

- ## SECURITY — do these at the Pi (repo is public on GitHub)

  Two committed-secret issues need a hands-on fix on the Pi. Neither can be fully
  fixed from the dev machine because the live data lives on the Pi.

  ### A. Rotate the leaked keg-sheet write URL
  The Google Apps Script `/exec` URL (deployed "Execute as: Me, Access: Anyone")
  was committed to this public repo, so anyone who read it can write to the keg
  sheet with no auth. The URL has been redacted from this file, but it's still in
  git history — assume it's compromised and **revoke it**:

  1. Open the keg Google Sheet → Extensions → Apps Script → Deploy → **Manage
     deployments**.
  2. **Archive/delete** the current web-app deployment. This kills the leaked URL.
  3. Create a **new** deployment (Execute as: Me, Access: Anyone) → copy its new
     `/exec` URL.
  4. Put the new URL only in `/etc/brewplanner.env` (never in git):
     `sudo nano /etc/brewplanner.env` → set `KEG_SHEET_WRITE_URL=<new /exec URL>`
     then `sudo systemctl restart checklist-server.service`.
  5. (Optional, recommended) Add a shared-secret check inside
     [keg-updater.gs](apps/server/google-apps-script/keg-updater.gs) so the URL
     alone isn't a capability — require a secret field in the POST body and have
     the server send it from another env var.

  ### B. Stop tracking the live database and move it out of the repo tree
  `data/checklist.sqlite` is git-tracked. On the Pi that path is the **live** DB
  (`DATABASE_PATH` in checklist-server.service), holding the admin password hash
  and device API-key hashes. The committed copy is currently an old empty one, but
  any future `git add`/commit on the Pi would push those hashes to the public repo
  — and a stray `git reset --hard` / `git checkout -- .` would **wipe your live DB
  and lock you out**. Fix it on the Pi, in this order:

  ```bash
  cd /home/brewplanner/checklist
  sudo systemctl stop checklist-server.service          # quiesce the DB

  # Move the live DB (and any WAL/SHM sidecars) out of the repo tree
  sudo mkdir -p /var/lib/brewplanner
  sudo mv data/checklist.sqlite* /var/lib/brewplanner/ 2>/dev/null
  sudo chown -R brewplanner:brewplanner /var/lib/brewplanner

  # Point the server at the new path (survives git pulls + rebuilds)
  sudo nano /etc/brewplanner.env                        # add:
  #   DATABASE_PATH=/var/lib/brewplanner/checklist.sqlite

  # Untrack the old path so it can never be committed again
  git rm --cached data/checklist.sqlite
  git commit -m "Stop tracking the live SQLite database"
  git push

  sudo systemctl restart checklist-server.service
  ```
  After this, confirm the dashboard still shows your data (it's now reading from
  `/var/lib/brewplanner`). `.gitignore` already ignores `*.sqlite`, so the new
  path won't be re-added.

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
    KEG_SHEET_WRITE_URL=<paste the NEW /exec URL — see the SECURITY section at the top of this file; the old URL was leaked and must be revoked>

  Then restart the server:
    sudo systemctl restart checklist-server.service

- ## Incorporate the readings from the TILT hydrometer to log to brewersfriend. "The Tilt wireless hydrometer operates on bluetooth. Log readings from the phone app or using a Raspberry pi with this Cloud URL. Turn on Tilt integration in your brew session under the Fermentation tab to start collecting temperature and gravity readings. 
  Cloud URL: https://log.brewersfriend.com/tilt/5a2c07e701f38d2c83ff2289df53f598c927129f" 

- ## Implement Brew System control. 

- ## Apparent attenuation & ABV live tracker — compute OG→current % attenuation and estimated ABV from Tilt readings; show projected final ABV.

- ## Test SOnos integration on Kiosk


- ## Water profile calculator

- ## Make sure the brewsystem actually uses the updated settings (especially for auto efficiency control) after theyre updated (in the same session).. currently it appears a reboot is needed for the setting change to take effect? Also make auto efficiency control adjustable per pot and not global for both