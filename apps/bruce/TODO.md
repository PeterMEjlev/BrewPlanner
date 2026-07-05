# Bruce — improvement backlog

Findings from a full review of the engine (`src/engine/`), the function modules
(`src/functions/`), and how Bruce sits in the BrewPlanner deployment. Ordered
by impact within each section; **P1** = fix before relying on Bruce day-to-day,
**P2** = high value, **P3** = nice to have.

---

## Reliability

### 1. (P1) Bruce goes permanently deaf when the OpenAI session drops
The WebSocket to OpenAI is opened once at startup and never re-established.
`RealtimeClient` emits `disconnected` on close (src/engine/RealtimeClient.js:68)
but **nobody listens to it** — after any network blip, OpenAI restart, or the
Realtime session hitting its server-side max lifetime:
- the wake word still triggers and the plop plays, but every audio chunk is
  silently dropped (`sendAudioChunk` no-ops when `!_sessionReady`), so Bruce
  listens and never answers;
- fired reminders are silently swallowed (`speak()` returns early when
  `!isReady`, src/engine/index.js:149) — a "add hops in 60 min" reminder just
  never happens, which is the worst possible failure on a brew day.

Preferred fix: **connect lazily per conversation** — open the session on wake
word (start connecting while the plop plays to hide the latency), close it
after the follow-up window ends or a few idle minutes. This also fixes #6
(context growth) for free. Minimum fix: listen for `disconnected` and
reconnect with backoff; have `speak()` queue while reconnecting instead of
dropping.

### 2. (P1) The state machine can wedge forever in `thinking`
There is no timeout on the `thinking` state — its only exits are
`responseDone`/`speakingEnd` events from the server. If the WS dies
mid-response (or an event is simply missed), Bruce is stuck: mic data is
routed nowhere (neither wake word nor streaming) until a service restart. Add
a per-state watchdog (e.g. `thinking` > 30 s → log, clear buffers, force
`idle`). Pairs with #1: the watchdog is what notices the dead session.

### 3. (P1) The microphone is never restarted if sox dies
When the sox/arecord child exits, `AudioManager` emits an `error` and nothing
more — Bruce keeps running but is deaf (src/engine/AudioManager.js:64-68 and
80-82). A USB hiccup on the Pi kills the mic permanently. Auto-restart the
recorder with backoff on `error`/unexpected exit, and log loudly if it keeps
dying.

### 4. (P2) Latent: functions registered after `start()` never reach the model
Tool definitions are sent once in `_configureSession` at connect time.
`registerFunction()`'s docstring says "Can be called before or after start()"
(src/engine/index.js:123-126) but a late registration never re-sends
`session.update`, so the model can't see the new tool. Either re-send the
session config on late registration or fix the docstring. (Today `main.js`
registers everything before `start()`, so this is latent — but #1's
reconnect-per-conversation would re-send tools anyway.)

### 5. (P3) Grammar bug: "1 kegs of NEIPA"
`src/functions/kegs.js` builds `` `${typeKegs.length} kegs of ${type}` `` —
singular counts say "1 kegs" (verified in live output). Same for the
"X kegs are empty" line. TTS reads it verbatim. Pluralize like tools.js does
for hours/minutes.

---

## Latency & cost

### 6. (P2) Conversation history grows without bound
One session is kept open for the lifetime of the process, so every past turn
is re-billed as input context on every new turn — after a long brew day the
per-question token cost has multiplied for no user-visible benefit.
Reconnect-per-conversation (#1) resets context naturally. If cross-question
memory within a session is worth keeping, cap it instead (reset after N turns
or M minutes idle). Note the trade-off: today Bruce *can* answer "what did I
just ask?" — decide whether that matters before resetting aggressively.

### 7. (P2) Migrate off the beta Realtime API / preview model
`RealtimeClient` pins `gpt-4o-mini-realtime-preview` with the
`OpenAI-Beta: realtime=v1` header (src/engine/RealtimeClient.js:6,46). OpenAI's
GA Realtime API (`gpt-realtime-mini` / `gpt-realtime`) is cheaper, noticeably
better at instruction-following and tool calls, and the beta protocol will
eventually go away. Migration touches the session.update shape and several
event names (`response.output_audio.delta`, etc.) in RealtimeClient. While at
it: make the model an env override (`BRUCE_REALTIME_MODEL`) and consider
`gpt-4o-mini-transcribe` over `whisper-1` for input transcription.

### 8. (P2) Every function-calling turn costs three model round-trips
The announce → execute → results phasing (src/engine/RealtimeClient.js:102-116,
269-344) was built to force the mini model to speak results reliably, but it
adds two extra responses of latency per question ("what's the BK temp?" →
announce, tool call, then the answer). With a GA model (#7), try collapsing:
let the model call tools directly and speak the `function_call_output` in one
follow-up response. Keep the phased mode behind a config flag as fallback —
the `[SYSTEM] you MUST speak…` injection exists because relaying used to fail.

### 9. (P3) Replace manual silence detection with server-side semantic VAD
Fixed-threshold RMS (`SILENCE_ENERGY_THRESHOLD: 200`, 1.5 s of silence, then
commit) is the main source of perceived lag and misfires in a noisy brewery
(pumps, boil). The GA API's semantic VAD ends the turn when you *finish a
sentence*, not after a fixed silence — faster and far more robust. Smaller
alternative if staying manual: calibrate an ambient noise floor while idle and
set the threshold relative to it instead of hardcoding 200 for every room.

---

## Voice UX

### 10. (P2) Wire up barge-in — it's already 90 % built
`AudioEchoCanceller` (energy-gate echo estimation, auto-calibrating, fully
implemented) is **imported by nothing**, and `RealtimeClient.cancelResponse()`
+ `AudioManager.stopPlayback()` are also never called. You cannot interrupt
Bruce mid-way through reading 17 kegs. Wiring plan, all in
src/engine/index.js: while `speaking`, feed speaker chunks to
`canceller.feedFarEnd()` and mic chunks to `canceller.detectBargeIn()`; on
trigger → `stopPlayback()` + `cancelResponse()` + transition to `listening`.
The config comment even documents a `BARGE_IN_ENERGY_THRESHOLD` that doesn't
exist — add it when wiring.

### 11. (P2) Volume control regression + `set_volume` voice function
The brew-system UI had a Bruce volume slider (removed with the Electron
integration); the engine's `setVolume()` is now unreachable. Add
`BRUCE_VOLUME` env for a default, and register a `set_volume` function so
"Bruce, speak at half volume" works. Note: `AudioManager` only *attenuates*
(gain < 1.0 branch, src/engine/AudioManager.js:279) — allow modest boost >1.0
with clipping guard, since Pi speakers are often quiet.

### 12. (P3) Merge same-named devices in spoken sensor summaries
Three fermenter sensors produce "Fermenter — pressure… Fermenter —
temperature… Fermenter — gravity…" (verified in live output of
`get_fermenter_status`). Group `latest` readings by device name in
src/functions/stats.js so it reads as one sentence per thing: "Fermenter —
pressure 1.14 bar, temperature 18.4°C cooling toward 18, gravity 1.019."

---

## New features (the server APIs already exist — Bruce just needs functions)

### 13. (P2) Bring back the timer-finished announcement (migration regression)
On the old rig, the UI told Bruce to announce when the brew timer hit zero;
that wiring died with the Electron integration. Reimplement Bruce-side: after
`control_timer` starts a countdown, poll `/api/brew-system/state` (~5 s
cadence, only while a countdown is known to be running, stop on offline) and
`speak()` when `timer.seconds` reaches 0. Don't poll 24/7 — the rig is usually
off and every probe waits out the proxy's 2.5 s timeout.

### 14. (P2) Keg edits by voice
`PUT /api/kegs/:number` (Apps-Script-backed) already powers the dashboard's
keg editor. Add `update_keg`: "keg 5 is empty", "mark keg 3 dirty", "keg 7 is
the new NEIPA at 6.2 %". Voice + a shared sheet is a great fit — hands are
usually wet when a keg kicks.

### 15. (P2) Fermenter setpoint by voice
`POST /api/devices/:id/setpoint` exists (Inkbird controller). Add
`set_fermenter_temperature`: resolve the device by name/type from
`/api/devices`, confirm the current setpoint in the reply. "Bruce, set the
fermenter to 19 degrees" — cold-crash without opening a laptop.

### 16. (P3) Brewery to-do list by voice
`GET/POST /api/todos` exist. `add_todo` + `get_todos`: "add 'order more
CO2' to the list", "what's on the to-do list?".

### 17. (P2) Reminders v2: list, cancel, persist
Reminders live in an in-memory Map (src/functions/tools.js) — a crash,
deploy, or the reconnect work in #1 loses them silently, and there's no way to
ask "what reminders are running?" or cancel one. Add `list_reminders` /
`cancel_reminder`, and persist `{message, firesAt}` to a small JSON file so
restarts re-arm pending reminders (announce "I restarted, your hop reminder
is still set for 3:40" on recovery).

### 18. (P3) Fermentation progress: attenuation / ABV / days-to-FG
The web app already fits gravity curves (apps/web/src/gravityForecast.ts).
A `get_fermentation_progress` function reading `/api/devices/:id/history`
(gravity metric) could speak apparent attenuation, estimated ABV from
OG→current, and the forecast to final gravity — mirrors the "ABV live
tracker" item on the main BrewPlanner TODO.

### 19. (P3) Proactive alert announcements (opt-in)
Bruce can already *answer* about alerts; he could also *announce* new
critical ones (fermentation done, sensor offline) by polling `/api/alerts`
for unseen IDs and `speak()`-ing them. Needs a mute window / quiet hours and
an env kill-switch — an unprompted voice at 3 a.m. is a bug, not a feature.

### 20. (P3) Sonos control by voice
`/api/music/*` (play, pause, next, previous, volume, now-playing) already
control the brewery SYMFONISK. "Bruce, pause the music" / "what's playing?"
— trivial functions, high fun-per-line-of-code. Bonus: duck or pause music
while Bruce listens/speaks, via the same endpoints.

### 21. (P2) Status API → fill in the dashboard's Bruce page
The `/bruce` page is a placeholder. Design that unblocks it: Bruce serves a
tiny HTTP API on `127.0.0.1` (state, rolling transcript of recent turns,
`POST /speak`, `POST /volume`), and the BrewPlanner server proxies it as
`/api/bruce/*` behind `requireAdmin` — same pattern as the brew-system proxy,
and it restores the old Electron "push a message for Bruce to speak" ability
(useful for testing without a mic, and for other server features to talk
through Bruce). The dashboard page then shows live state + transcript.

### 22. (P3) Mute / sleep function
"Bruce, go to sleep for an hour" → disable wake-word handling for a duration
(and a `BRUCE_MUTED` startup env). Cheap, and useful when the brewery is loud
or guests keep saying "Bruce" as a joke.

---

## Code quality & ops

### 23. (P2) Turn the migration smoke test into `npm test`
The migration was verified with a throwaway script (stub registration of all
19 functions, engine load, calculator outputs). Commit it as
`apps/bruce/test/` with real assertions: calculators (dilution, hydrometer,
carbonation formula values), keg summary formatting (incl. the "1 kegs" fix in
#5), stats formatting/grouping, and envelope handling (`unwrap` offline/not-
configured paths). All pure logic — no audio or network needed.

### 24. (P3) Make config.js tunables env-overridable
Thresholds currently require editing a tracked file on the Pi (then a deploy
reverts it). Read each tunable as
`Number(process.env.BRUCE_SILENCE_THRESHOLD ?? 200)`-style with the file as
defaults, so per-room tuning lives in `/etc/brewplanner.env`.

### 25. (P3) Journald hygiene for debug energy logging
`DEBUG_ENERGY: 'listening'` writes `\r`-rewritten lines via
`process.stdout.write` (src/engine/index.js:277) — carriage returns turn the
journal into noise on the Pi. Emit one plain line per second instead when not
attached to a TTY.

### 26. (P3) Retire the stale copies of Bruce
`Desktop/Bruce-v2` is now an unused archive of the vendored engine (and
`_computeRMS` is already duplicated between engine/index.js and the echo
canceller). Mark Bruce-v2's README as "moved to BrewPlanner apps/bruce" (or
delete it) before the copies diverge and someone fixes a bug in the wrong one.

### 27. (P3) systemd hardening for bruce.service
Once #2's watchdog exists, let it exit(1) on unrecoverable wedges so
`Restart=on-failure` heals Bruce; add `MemoryMax` (a leaky native audio stack
shouldn't take down the Pi) and `RestartSec` backoff review. Optional:
`WatchdogSec=` + `sd_notify` pings from the idle loop for a true liveness
check.

---

## Suggested first bites

`#1 + #2` (lazy connect + watchdog — turns Bruce from "demo" into "appliance"),
then `#10` (barge-in, mostly wiring), `#5` (one-line fix), and `#13/#17`
(the two brew-day features whose absence actually burns a batch).
