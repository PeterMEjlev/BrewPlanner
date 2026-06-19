- ## Look for security issues

- ## Add support for
  - Electricity (Watt) usage
  - Water usage 
  - Temperature of fermentor (another Inkbird 308)
  - Temperature of brewery (another Inkbird 308)
  - Gravity of beer/wort fermentation (Tilt gravity sensor.) Tilt broadcasts BLE/iBeacon data.

- ## Improve phone layout for dashboard (make a phone specific layout? (so we have rpi (kiosk, desktop and phone specific layouts)))?

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

- ## Add support for larger monitor screens. currently for a large monitor the fermenter card is stretched a lot vertically in order to make the dashboard fill out the monitor. Prioritize enlarging the entire dashboard (and not just the fermenter card graphs). Enlarge the entire dashboard a maximum if 2 times. if this still doesnt fill out the screen, then some unused space is acceptable. Avoid stretching the graphs on the main dashboard more than 1.5 in any given direction (unless both directions are enlarged). this is to avoid stretched out graphs. 

- ## Add a zoom setting in the settings allowing the user to zoom the size of the entire dashboard to their liking