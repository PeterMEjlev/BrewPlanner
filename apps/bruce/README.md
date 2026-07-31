# Bruce — brewery voice assistant

Wake-word voice assistant ("Bruce!") that controls the brewing rig, checks the
keg inventory, and reads fermenter/sensor data — by voice, through OpenAI's
Realtime API.

Migrated here from brew-system-v3 (where it ran inside the rig's Electron app).
It now runs on the BrewPlanner Pi as its own systemd service and talks to the
BrewPlanner server over loopback, which passes as trusted-local — no tokens.

## Layout

- `src/engine/` — the voice engine, vendored from the old standalone Bruce-v2
  repo: wake word, mic capture (sox/ALSA), OpenAI Realtime WebSocket, speaker
  playback, function-calling registry. Only the paths and `WakeWordDetector`
  differ from the original — that one was rewritten around openWakeWord when
  the Picovoice key died.
- `src/functions/` — what Bruce can *do*:
  - `hub.js` — **everything about BrewPlanner**, fetched from the server rather
    than written here. It reads the tool definitions from
    `GET /api/bruce/voice/tools` at startup and registers each one as a proxy
    to `POST /api/bruce/voice/tool`, where it runs against the hub's own
    database and is audited like any other change.
  - `brewSystem.js` — rig control via `/api/brew-system/*` (audited,
    offline-aware). Local because this Bruce is the *only* one that may switch
    the heaters on: the dashboard and the phone can read the rig but not drive
    it, on the grounds that whoever is talking to this speaker is standing next
    to the kettle.
  - `tools.js` — reminders (they fire through this machine's speaker) and
    Bruce's own speaking volume. No network.

  There used to be six more files here — kegs, stats, devices, recipes, todos,
  settings — each a second implementation of a tool the server already had.
  Two copies of "what is in the fermenter" drift, and they did: the server grew
  the brew-day log, sensor history and the brewing calculators while this
  process kept answering from the older set. One tool set now serves all three
  Bruces (this speaker, the written chat, and the phone), so a tool added to
  `apps/server/src/bruce/tools.ts` appears in all of them at once.
- `src/main.js` — entry point: wires functions, env, and journald-friendly logs
- `src/statusServer.js` — loopback HTTP API (state, transcript, speak, volume)
  that the BrewPlanner server proxies as `/api/bruce/*` for the dashboard page
- `config.js` — voice-detection tunables (silence thresholds, timeouts)
- `system-prompt.txt` — Bruce's spoken-persona instructions
- `wake-words/` — the openWakeWord ONNX models, one of which *is* the wake
  phrase; see the README in there

## Running

Needs `OPENAI_API_KEY` (on the Pi it lives in `/etc/brewplanner.env`; locally
use an `.env` file in this directory), a microphone and speaker, and `sox` on
the PATH. The wake word is detected locally and needs no key.

```
npm run dev --workspace @checklist/bruce   # local dev (Windows works — sox waveaudio)
npm test --workspace @checklist/bruce      # state machine + function tests (no audio/network)
sudo systemctl start bruce.service          # on the Pi
```

Pi setup (audio packages, service enablement, device selection):
see [deploy/README-bruce.md](../../deploy/README-bruce.md).
