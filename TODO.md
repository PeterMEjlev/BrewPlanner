

- ## Add support for
  - Electricity (Watt) usage
  - Water usage 
  - Temperature of fermentor (another Inkbird 308)
  - Temperature of brewery (another Inkbird 308)
  - Gravity of beer/wort fermentation (Tilt gravity sensor.) Tilt broadcasts BLE/iBeacon data.

- ## Incorporate the readings from the TILT hydrometer to log to brewersfriend. "The Tilt wireless hydrometer operates on bluetooth. Log readings from the phone app or using a Raspberry pi with this Cloud URL. Turn on Tilt integration in your brew session under the Fermentation tab to start collecting temperature and gravity readings. 
  Cloud URL: https://log.brewersfriend.com/tilt/5a2c07e701f38d2c83ff2289df53f598c927129f" 



- ## Implement Brew System control. 

- ## Apparent attenuation & ABV live tracker — compute OG→current % attenuation and estimated ABV from Tilt readings; show projected final ABV.

- ## Water profile calculator

- ## Make sure the brewsystem actually uses the updated settings (especially for auto efficiency control) after theyre updated (in the same session).. currently it appears a reboot is needed for the setting change to take effect? Also make auto efficiency control adjustable per pot and not global for both