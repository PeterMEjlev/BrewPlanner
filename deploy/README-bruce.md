# Bruce on the Pi — one-time setup

Bruce (apps/bruce) is the wake-word voice assistant, migrated here from
brew-system-v3. He runs on the BrewPlanner Pi as his own systemd service and
talks to the BrewPlanner server over loopback, so he needs no login or token.

Everything below is a **one-time** setup, done on the Pi over SSH
(`ssh brewplanner@BrewPlanner`). Until it's done, the Pi deploys exactly as
before — `bruce.service` is opt-in and `deploy/update.sh` skips it while it
is not enabled.

> **This page is only about the hands-free Bruce in the brewery** — the one you
> call across the room without touching anything. Two other ways of reaching
> him need none of it, only `OPENAI_API_KEY` in `/etc/brewplanner.env` (step 3
> below) and one `npm run knowledge` to index the books (see
> `knowledge/README.md`):
>
> - the **written chat** on the `/bruce` page, answered by the BrewPlanner
>   server itself;
> - the **Talk button** on that same page, which is your phone or laptop
>   holding a voice conversation of its own. See "Talking from a phone" below.

## 0. Prerequisites

- A USB microphone and a speaker plugged into the Pi (3.5 mm jack, USB, or the
  same USB device for both). Without them the service starts and immediately
  exits with an audio error — set everything else up first if the hardware
  isn't there yet.
- An OpenAI API key. That is the only key Bruce needs — wake-word detection
  runs locally with openWakeWord (see `apps/bruce/wake-words/README.md`) and
  costs nothing.

## 1. System packages

```bash
sudo apt update
sudo apt install -y sox libasound2-dev alsa-utils
```

- `sox` records the microphone (the engine shells out to it).
- `libasound2-dev` is the ALSA header package the `speaker` npm module compiles
  against. It is an **optionalDependency**, so a plain `npm install` before this
  package exists succeeds with a warning and Bruce simply can't speak; after
  installing it, build it:

```bash
cd ~/checklist
deploy/ensure-bruce-audio.sh
```

That script exists because `npm rebuild speaker` is not enough on a 64-bit Pi:
the module bundles mpg123, which ships build configs for `linux/arm`, `ia32`
and `x64` but **not `arm64`**, so the compile dies with `config.h: No such file
or directory`. It copies the x64 config to `arm64` (right for aarch64 — 64-bit
type sizes, and the only thing built here is the ALSA output layer, which has
no CPU-specific code) and then builds. It is idempotent, and `deploy/update.sh`
runs it on every deploy so a wiped `node_modules` can't quietly leave Bruce mute.

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

> `BRUCE_MIC_DEVICE` only sets `AUDIODEV`, which `sox --default-device` ignores
> unless a driver is also named — hence `Environment=AUDIODRIVER=alsa` in
> `bruce.service`. Without it sox exits immediately with "no default audio
> device configured" and Bruce logs "Microphone stream died" on a loop.

### Check the noise floor before trusting the defaults

Bruce's silence detection compares mic RMS against fixed thresholds
(`SILENCE_ENERGY_THRESHOLD` 200, `MIN_SPEECH_ENERGY` 400 in `apps/bruce/config.js`,
scale 0–32768). A hot USB mic in a room with a humming fridge can sit *above*
both while nobody is speaking — then Bruce never sees silence, never commits on
a pause, and every turn drags on to `MAX_UTTERANCE_MS`. Measure with the room
quiet and again while speaking from where you'll stand:

```bash
arecord -D plughw:3 -f S16_LE -r 16000 -c 1 -d 5 /tmp/t.wav && sox /tmp/t.wav -n stat
# "RMS amplitude" x 32768 = the number the thresholds are compared against
```

Then either turn the capture gain down (`alsamixer`, F6 to pick the card, F4 for
capture) or raise both thresholds in `/etc/brewplanner.env`, keeping silence
comfortably above the quiet-room floor and speech comfortably above that:

```
BRUCE_SILENCE_ENERGY_THRESHOLD=900
BRUCE_MIN_SPEECH_ENERGY=1400
```

Once Bruce is running, every turn logs `[Bruce] Peak energy: <n> (min: <m>)` to
the journal — the easiest way to refine these against real speech.

## 3. Keys

Add to `/etc/brewplanner.env` (see `deploy/brewplanner.env.example` for the
full annotated block):

```
OPENAI_API_KEY=sk-...
# optional:
# BRUCE_VOICE=alloy
# BRUCE_MIC_DEVICE=plughw:1
# BRUCE_WAKE_WORD_THRESHOLD=0.5
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

Say the wake phrase near the mic — you should hear the plop, then ask e.g.
*"how are the kegs?"* or *"what's fermenting?"*.

> **The wake phrase is "hey Jarvis" until you train a "hey Bruce" model.**
> openWakeWord ships pre-trained models for a handful of phrases only, and
> "Bruce" isn't one of them — see the next section. Everything else about Bruce
> is unchanged; only the two words that wake him are borrowed.

From here on, every deploy (`deploy/update.sh` or the dashboard Update button)
restarts Bruce automatically along with the other services.

## 6. Tune the wake-word threshold

A detection fires when the model scores above `BRUCE_WAKE_WORD_THRESHOLD`
(default `0.5`). To see the actual numbers, set `BRUCE_WAKE_WORD_DEBUG=1` and
restart — the journal then prints the highest score each second:

```
[Bruce] Wake-word peak score: 0.012 (threshold 0.5)
```

Watch it with the brewery noisy but nobody talking (that's your false-positive
floor), then while saying the phrase from where you normally stand. Put the
threshold between the two, then remove the debug var. Raise it if Bruce wakes
up on his own; lower it if you have to shout.

## Training a "hey Bruce" model

Custom openWakeWord models are trained from synthetic speech — you never record
yourself — and it's free and unattended. Use the project's
[automatic training notebook](https://github.com/dscripka/openWakeWord/blob/main/notebooks/automatic_model_training.ipynb)
on Google Colab: set the target phrase to **"hey Bruce"**, run all cells, and
come back in roughly 90 minutes for a `.onnx` file.

Then:

```bash
scp hey_bruce.onnx brewplanner@BrewPlanner:~/checklist/apps/bruce/wake-words/
# in /etc/brewplanner.env:
#   BRUCE_WAKE_WORD_MODEL=/home/brewplanner/checklist/apps/bruce/wake-words/hey_bruce.onnx
sudo systemctl restart bruce.service
```

Commit the model so deploys keep it (that directory is tracked, and the deploy
checkout reverts untracked-file collisions). Prefer **"hey Bruce"** to a bare
"Bruce": openWakeWord needs a few syllables to work with, and one short word in
a room with pumps running is a recipe for false triggers. Re-tune the threshold
after swapping — a custom model's scores won't line up with `hey_jarvis`'s.

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

## Talking from a phone or a laptop

Nothing on this page is needed for that one. The **Talk** button above the
composer on `/bruce` opens a voice conversation held by the browser itself: it
takes the device's own microphone and speaker, and connects straight to
OpenAI's Realtime API. Press it, talk, press **End** to hang up — no wake word,
because there is a button.

What the server does is mint a short-lived credential per call
(`POST /api/bruce/voice/session`), so `OPENAI_API_KEY` never leaves the Pi, and
answer the tool calls that come out of the conversation
(`POST /api/bruce/voice/tool`). He gets the same tools as the written chat —
the fermenter, the kegs, the to-do list, the settings — plus `search_library`
for the books, and every change is audited against whoever is logged in. Each
finished exchange is written into the open chat thread, so a question asked out
loud can be scrolled back to and followed up in writing.

**It needs HTTPS.** Browsers only hand over a microphone in a secure context,
which means:

| How you reach the hub | Talk button |
| --- | --- |
| `https://` through the Cloudflare tunnel | works |
| The Pi's own kiosk (`localhost:3000`) | works |
| The Android app (serves from `https://localhost`) | works |
| `http://192.168.3.3` or `http://brewplanner.local` on the LAN | not offered — the page says to use the https address |

The audio is billed as OpenAI Realtime audio, by the minute, and is charged
directly to the account by the browser's own session — it does not appear in
the per-chat cost estimates on the Bruce page, which only price the written
chat. Settings, all optional, in `/etc/brewplanner.env`:

- `BRUCE_VOICE_MODEL` — the speech model for browsers alone (default
  `gpt-realtime-mini`, as on the Pi; `gpt-realtime` listens better in a noisy
  brewery and costs more).
- `BRUCE_VOICE` — which voice he answers in (default `alloy`).
- `BRUCE_VOICE_VAD` — set to `server_vad` if the default `semantic_vad` cuts in
  while you are still thinking mid-sentence.

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
- **`Cannot find module 'speaker'`** — step 1's `deploy/ensure-bruce-audio.sh`
  (needs `libasound2-dev` first).
- **`no such file or directory ... .onnx`** — the wake-word models are missing
  from `apps/bruce/wake-words/`, or `BRUCE_WAKE_WORD_MODEL` points at a file
  that isn't there. All three (`melspectrogram`, `embedding_model`, and the
  phrase model) must sit in the same directory.
- **`Microphone stream died — restarting in …` on a loop** — sox can't open the
  mic. Check `AUDIODRIVER=alsa` reached the process
  (`systemctl show bruce.service -p Environment`), and reproduce by hand:
  `AUDIODRIVER=alsa AUDIODEV=plughw:3 sox --default-device -r 16000 -c 1 -b 16 -e signed-integer -t raw - | wc -c`
- **Wake word never triggers** — wrong mic device (step 2), the mic level is too
  low (`alsamixer`, F6 to pick the card, raise capture volume), or the threshold
  is too high (step 6). `BRUCE_WAKE_WORD_DEBUG=1` tells you which: a peak score
  that never moves off ~0 means no usable audio is reaching the detector.
- **Bruce wakes up on his own** — raise `BRUCE_WAKE_WORD_THRESHOLD` (step 6).
  Expect this to need attention if you train a single-word "Bruce" model.
- **Bruce listens for the full 10 s after every question** — the room's noise
  floor is above the silence threshold, so the pause never registers. See
  "Check the noise floor" in step 2.
- **Bruce hears but answers "the brew system is offline"** — that's normal when
  the rig is powered down; it means everything on the BrewPlanner side works.
- **Voice detection too eager / too sluggish** — tune the thresholds in
  `apps/bruce/config.js` (they are commented).
