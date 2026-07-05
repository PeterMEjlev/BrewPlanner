# Bruce — brewery voice assistant

Wake-word voice assistant ("Bruce!") that controls the brewing rig, checks the
keg inventory, and reads fermenter/sensor data — by voice, through OpenAI's
Realtime API.

Migrated here from brew-system-v3 (where it ran inside the rig's Electron app).
It now runs on the BrewPlanner Pi as its own systemd service and talks to the
BrewPlanner server over loopback, which passes as trusted-local — no tokens.

## Layout

- `src/engine/` — the voice engine, vendored from the old standalone Bruce-v2
  repo: Porcupine wake word, mic capture (sox/ALSA), OpenAI Realtime WebSocket,
  speaker playback, function-calling registry. Only two lines changed from the
  original (asset/config paths).
- `src/functions/` — what Bruce can *do*, all against the local server's API:
  - `brewSystem.js` — rig control via `/api/brew-system/*` (audited, offline-aware)
  - `kegs.js` — keg inventory via `/api/kegs`
  - `stats.js` — fermenter status, sensor readings, alerts
  - `tools.js` — reminders + brewing calculators (no network)
- `src/main.js` — entry point: wires functions, env, and journald-friendly logs
- `config.js` — voice-detection tunables (silence thresholds, timeouts)
- `system-prompt.txt` — Bruce's spoken-persona instructions
- `wake-words/` — Porcupine models (`RPi` for the Pi, `windows` for dev)

## Running

Needs `OPENAI_API_KEY` and `PICOVOICE_ACCESS_KEY` (on the Pi these live in
`/etc/brewplanner.env`; locally use an `.env` file in this directory), a
microphone and speaker, and `sox` on the PATH.

```
npm run dev --workspace @checklist/bruce   # local dev (Windows works — sox waveaudio)
sudo systemctl start bruce.service          # on the Pi
```

Pi setup (audio packages, service enablement, device selection):
see [deploy/README-bruce.md](../../deploy/README-bruce.md).
