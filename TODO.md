- Bruce voice mode: Make it work on phones/laptops too. instead of a wakeword, it should be a button to initate conversaiton (like in chatGPT voice mode)

- Bruce voice: Train "Hey Bruce" wakeword model instead of "Hey Jarvis"

- Recipe back up: does it work?



- ## Add support for
  - Electricity (Watt) usage
  - Water usage 
  - Gravity of beer/wort fermentation (Tilt gravity sensor.) Tilt broadcasts BLE/iBeacon data.

- ## Incorporate the readings from the TILT hydrometer to log to brewersfriend. "The Tilt wireless hydrometer operates on bluetooth. Log readings from the phone app or using a Raspberry pi with this Cloud URL. Turn on Tilt integration in your brew session under the Fermentation tab to start collecting temperature and gravity readings. 
  Cloud URL: https://log.brewersfriend.com/tilt/5a2c07e701f38d2c83ff2289df53f598c927129f" 



- ## Implement Brew System control. 

- ## Bruce voice assistant — finish the Pi setup (code is migrated, hardware isn't)
  Bruce now lives in `apps/bruce` and runs on THIS Pi (removed from brew-system-v3).
  Blocked on: SSH access to the Pi + a USB microphone and speaker.
  When both are available, follow **deploy/README-bruce.md** step by step:
  1. `sudo apt install -y sox libasound2-dev alsa-utils`, then `npm rebuild speaker`
  2. Pick/test mic with `arecord -l` (set `BRUCE_MIC_DEVICE` if not default)
  3. Add `OPENAI_API_KEY` + `PICOVOICE_ACCESS_KEY` to `/etc/brewplanner.env`
  4. Reinstall the sudoers whitelist (it now covers bruce.service)
  5. `sudo systemctl enable --now bruce.service`, check `journalctl -u bruce.service -f`
  The Bruce page itself is built: it is a written chat (server-side, works today
  without any of the above) with the voice service's live state, volume, speak
  box and spoken transcript in the right-hand rail once the hardware is in.

- ## Apparent attenuation & ABV live tracker — compute OG→current % attenuation and estimated ABV from Tilt readings; show projected final ABV.

- ## Water profile calculator



---

# Optimization / improvement suggestions (code review)

Ordered by impact. The original themes — unbounded data growth, hot polling paths
doing repeated full-table work, tokens that never expire — are now all addressed;
what's left is structural.

(Original #1 readings retention, #2 devices hot path, #3 keg-sheet cache, #4 token
expiry/revocation, and #10 polling pause were completed 2026-07-03; #6 incremental
history polling, #7 static cache headers + compression, and #9 the cached auth
state on 2026-07-29, followed the same day by #5 incremental metric totals, #8
server hardening, #11 the shared-poll store, and #14 tests + CI. Item numbers
below are kept stable so cross-references still line up.)

## Frontend

### 12. Split the two giant page files
Dashboard.tsx = 2,239 lines, SettingsDesktop.tsx = 1,617. Both contain several
self-contained units (ferment-status hook, station card, keg summary, account mgmt
panel, update panel…) that could move to components/dashboard/ and
components/settings/. No behaviour change; better diffs/reviews/editor perf, and
ferment logic duplicated in KioskHome.tsx could converge.

### 13. Architectural option: push instead of poll
The server knows the instant new telemetry arrives (/api/ingest); clients wait for
their next poll. An SSE endpoint (GET /api/events) broadcasting a device-status
event on each accepted ingest would make dashboards update instantly, cut request
volume, and work through the tunnel. Keep polling as fallback. Optional — polling
does work.

## Next up by impact
#12 (split Dashboard.tsx / SettingsDesktop.tsx — `fermentationDone` has already
converged into ferment.ts, so the ferment-status hook is the natural next piece)
and #13 (SSE push instead of polling, now that one shared channel per resource
would be easy to feed from a single event stream).

Still untested after #14: the notify/checks.ts thresholds, and the keg grid's
optimistic-edit path.
