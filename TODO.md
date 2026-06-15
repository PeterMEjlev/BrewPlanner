- ## Look for security issues

- ## Add support for
  - Electricity (Watt) usage
  - Water usage 
  - Temperature of fermentor (another Inkbird 308)
  - Temperature of brewery (another Inkbird 308)
  - Gravity of beer/wort fermentation (Tilt gravity sensor.) Tilt broadcasts BLE/iBeacon data.

- ## Integrate Brewer's Friend
  - Connect the user's Brewer's Friend account to the server (API key / OAuth).
  - Let the user pick the recipe currently in the fermenter from their account.
  - The chosen recipe determines the beer style shown on the kiosk fermenter
    card (currently hardcoded to the "<Beer Style>" placeholder in KioskHome).

- ## Add Keg status sheets (keep the same visual as in brewsystem 3.0)

- ## !!!  update  RPI (Kiosk) GUI to reflect the same design as the Desktop version. same icons, colours for graphs etc. dont change the layout of the kiosk version, just make sure the theme / design style is the same. !!!

- ## Incorporate the readings from the TILT hydrometer to log to brewersfriend. "The Tilt wireless hydrometer operates on bluetooth. Log readings from the phone app or using a Raspberry pi with this Cloud URL. Turn on Tilt integration in your brew session under the Fermentation tab to start collecting temperature and gravity readings. 
  Cloud URL: https://log.brewersfriend.com/tilt/5a2c07e701f38d2c83ff2289df53f598c927129f" 

- ## SMS integration (or other phone notification - Email?) when kegged beers have been stored too long and not been drunk (prevent beer getting old)

- ## add inkbird set point stepper increment to settings