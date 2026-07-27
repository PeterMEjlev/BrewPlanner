# Bruce on the Pi — one-time setup

Bruce (apps/bruce) is the wake-word voice assistant, migrated here from
brew-system-v3. He runs on the BrewPlanner Pi as his own systemd service and
talks to the BrewPlanner server over loopback, so he needs no login or token.

Everything below is a **one-time** setup, done on the Pi over SSH
(`ssh brewplanner@BrewPlanner`). Until it's done, the Pi deploys exactly as
before — `bruce.service` is opt-in and `deploy/update.sh` skips it while it
is not enabled.

> **This page is only about talking to Bruce out loud.** The written chat on
> the `/bruce` page is answered by the BrewPlanner server itself and needs no
> microphone, no speaker, and no `bruce.service` — only `OPENAI_API_KEY` in
> `/etc/brewplanner.env` (step 3 below) and one `npm run knowledge` to index
> the books. See `knowledge/README.md`.

## 0. Prerequisites

- A USB microphone and a speaker plugged into the Pi (3.5 mm jack, USB, or the
  same USB device for both). Without them the service starts and immediately
  exits with an audio error — set everything else up first if the hardware
  isn't there yet.
- An OpenAI API key and a Picovoice access key (from https://console.picovoice.ai —
  the same one used when Bruce ran on the brew rig works).

## 1. System packages

```bash
sudo apt update
sudo apt install -y sox libasound2-dev alsa-utils
```

- `sox` records the microphone (the engine shells out to it).
- `libasound2-dev` is the ALSA header package the `speaker` npm module compiles
  against. It is an **optionalDependency**, so a plain `npm install` before this
  package exists succeeds with a warning and Bruce simply can't speak; after
  installing it, rebuild:

```bash
cd ~/checklist
npm rebuild speaker || npm install
```

- `alsa-utils` provides `arecord`/`aplay` for testing below.

## 2. Pick and test the audio devices

```bash
arecord -l         # list capture devices; note the card number, e.g. card 1
aplay -l           # list playback devices
arecord -D plughw:1 -f S16_LE -r 16000 -d 3 test.wav && aplay test.wav
```

If the mic is not the default device, set `BRUCE_MIC_DEVICE=plughw:1` (using
your card number) in `/etc/brewplanner.env`. Playback uses the ALSA default
device; make the speaker the default with `raspi-config` or `/etc/asound.conf`
if needed.

## 3. Keys

Add to `/etc/brewplanner.env` (see `deploy/brewplanner.env.example` for the
full annotated block):

```
OPENAI_API_KEY=sk-...
PICOVOICE_ACCESS_KEY=...
# optional:
# BRUCE_VOICE=alloy
# BRUCE_MIC_DEVICE=plughw:1
```

## 4. Refresh the sudoers whitelist (dashboard-updater Pis only)

`deploy/update.sh` now syncs and restarts `bruce.service`; the passwordless
whitelist must cover those commands or the dashboard "Update" button will log
a warning (Bruce steps are skipped, everything else still deploys):

```bash
sudo cp ~/checklist/deploy/brewplanner-deploy.sudoers /etc/sudoers.d/brewplanner-deploy
sudo chmod 0440 /etc/sudoers.d/brewplanner-deploy
sudo visudo -cf /etc/sudoers.d/brewplanner-deploy   # must print "parsed OK"
```

## 5. Install and enable the service

```bash
sudo cp ~/checklist/deploy/bruce.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bruce.service
journalctl -u bruce.service -f     # expect: "[Bruce] Ready — listening for wake word"
```

Say **"Bruce!"** near the mic — you should hear the plop, then ask e.g.
*"how are the kegs?"* or *"what's fermenting?"*.

From here on, every deploy (`deploy/update.sh` or the dashboard Update button)
restarts Bruce automatically along with the other services.

## Optional: enable barge-in (interrupting Bruce mid-speech)

Barge-in lets you talk over Bruce to cut him off ("Bruce— no, stop"). It ships
**disabled** because the echo gate has to be tuned to your room and speaker
volume first — a miscalibrated gate makes Bruce interrupt himself whenever he
hears his own voice. Once the basics work:

1. Set `BRUCE_DEBUG_ENERGY=all` in `/etc/brewplanner.env`, restart, ask Bruce
   something long (e.g. a full keg rundown) and watch
   `journalctl -u bruce.service -f`: the `[AEC]` lines show mic energy vs the
   expected echo (`excess=`) while he speaks.
2. Pick a `BRUCE_BARGE_IN_ENERGY_THRESHOLD` comfortably above the excess you
   see when *silent* and below the excess when *you* talk over him
   (default 400).
3. Set `BRUCE_BARGE_IN_ENABLED=1`, remove the debug var, restart.

## Notes on behaviour

- **The dashboard has a live Bruce page.** `/bruce` shows his state
  (idle/listening/thinking/speaking), the OpenAI session, a rolling
  conversation transcript, a volume slider, and a box to make him say
  something in the brewery — handy for testing the speaker before the mic
  works. It reads Bruce's loopback status API (port 3555,
  `BRUCE_STATUS_PORT`) through the server; when the service is down the page
  shows an offline card.
- **Speech model.** Bruce speaks through OpenAI's GA Realtime API
  (`gpt-realtime-mini` by default; set `BRUCE_REALTIME_MODEL=gpt-realtime`
  for the bigger one). The old beta API his brew-system incarnation used has
  been retired by OpenAI, so old configs pinning a `*-realtime-preview`
  model will not work.
- **Reminders survive restarts.** Pending reminders are saved to
  `~/.bruce/reminders.json` (`BRUCE_STATE_DIR` to relocate) and re-armed when
  the service starts; one that should have fired while Bruce was down is
  spoken belatedly if it's less than 10 minutes late.
- **The OpenAI session is on-demand.** It connects at the wake word (the beep
  masks the latency) and closes after ~2 minutes of idle
  (`BRUCE_SESSION_IDLE_TIMEOUT_MS`). Within that window Bruce remembers the
  conversation; after it, each conversation starts fresh. Dropped connections
  self-heal the same way, and a watchdog resets any conversation that hangs.
- **The microphone self-heals.** If the recorder process dies (USB hiccup),
  it is restarted automatically with backoff — check the journal for
  "Microphone stream died" if Bruce seems deaf.

## Troubleshooting

- **`Missing required environment variable ...` in the journal** — step 3.
- **`Cannot find module 'speaker'`** — step 1's `npm rebuild speaker` (needs
  `libasound2-dev` first).
- **Wake word never triggers** — wrong mic device (step 2), or the mic level is
  too low (`alsamixer`, F6 to pick the card, raise capture volume). Energy
  logging can help: set `DEBUG_ENERGY: 'listening'` in `apps/bruce/config.js`.
- **Bruce hears but answers "the brew system is offline"** — that's normal when
  the rig is powered down; it means everything on the BrewPlanner side works.
- **Voice detection too eager / too sluggish** — tune the thresholds in
  `apps/bruce/config.js` (they are commented).
