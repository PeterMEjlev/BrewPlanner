# Bruce — improvement backlog

Findings from a full review of the engine (`src/engine/`), the function modules
(`src/functions/`), and how Bruce sits in the BrewPlanner deployment. Ordered
by impact within each section; **P1** = fix before relying on Bruce day-to-day,
**P2** = high value, **P3** = nice to have. Completed items are removed;
numbering is kept stable so cross-references still line up.

---

## Latency & cost

### 8. (P2) Every function-calling turn costs three model round-trips
The announce → execute → results phasing in RealtimeClient was built to force
the old preview model to speak results reliably, but it adds two extra
responses of latency per question ("what's the BK temp?" → announce, tool
call, then the answer). Now that the GA `gpt-realtime-mini` is in place — and
noticeably better at tool calls — try collapsing: let the model call tools
directly and speak the `function_call_output` in one follow-up response. Keep
the phased mode behind a config flag as fallback — the `[SYSTEM] you MUST
speak…` injection exists because relaying used to fail. Needs testing with
the real mic/speaker before changing the default.

### 9. (P3) Replace manual silence detection with server-side semantic VAD
Fixed-threshold RMS (`SILENCE_ENERGY_THRESHOLD: 200`, 1.5 s of silence, then
commit) is the main source of perceived lag and misfires in a noisy brewery
(pumps, boil). The GA API's semantic VAD ends the turn when you *finish a
sentence*, not after a fixed silence — faster and far more robust. Smaller
alternative if staying manual: calibrate an ambient noise floor while idle and
set the threshold relative to it instead of hardcoding 200 for every room.

---

## Voice UX

### 12. (P3) Merge same-named devices in spoken sensor summaries
Three fermenter sensors produce "Fermenter — pressure… Fermenter —
temperature… Fermenter — gravity…" (verified in live output of the old
`get_fermenter_status`). They should read as one sentence per thing:
"Fermenter — pressure 1.14 bar, temperature 18.4°C cooling toward 18, gravity
1.019."

Now lives on the server: the spoken tools come from
apps/server/src/bruce/tools.ts (`fermenterSection`), so fixing it there fixes
the written chat and the phone's voice mode at the same time.

---

## New features (the server APIs already exist — Bruce just needs functions)

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

### 20. (P3) Sonos: the two pieces left
Control itself is done — `get_music` and `control_music` in
apps/server/src/bruce/tools.ts cover now-playing, the queue, play/pause,
skipping either way, shuffle, repeat and playing a queued track by title or
artist, so the speaker, the written chat and the phone all have it. What is
still open:

- **Volume.** Deliberately left out: Bruce's own `set_volume` is how loudly he
  speaks, and one spoken "turn it down" would have to choose between the two.
  Worth doing with a distinct name (`set_music_volume`) and a prompt line that
  says which is which.
- **Ducking.** Drop the music while he listens/speaks and restore it after —
  the original bonus on this item, and the thing that would make him usable
  with music actually on. Needs the pre-duck volume remembered somewhere that
  survives a crash mid-conversation, or the brewery is left at 10 % forever.

### 22. (P3) Mute / sleep function
"Bruce, go to sleep for an hour" → disable wake-word handling for a duration
(and a `BRUCE_MUTED` startup env). Cheap, and useful when the brewery is loud
or guests keep saying "Bruce" as a joke.

---

## Code quality & ops

### 25. (P3) Journald hygiene for debug energy logging
`DEBUG_ENERGY: 'listening'` writes `\r`-rewritten lines via
`process.stdout.write` (src/engine/index.js) — carriage returns turn the
journal into noise on the Pi. Emit one plain line per second instead when not
attached to a TTY.

### 26. (P3) Retire the stale copies of Bruce
`Desktop/Bruce-v2` is now an unused archive of the vendored engine (and
`_computeRMS` is already duplicated between engine/index.js and the echo
canceller). Mark Bruce-v2's README as "moved to BrewPlanner apps/bruce" (or
delete it) before the copies diverge and someone fixes a bug in the wrong one.
The engine copy there still speaks the retired beta protocol, so it no longer
works at all — one more reason to mark it dead.

### 27. (P3) systemd hardening for bruce.service
The state watchdog exists; optionally let it exit(1) on unrecoverable wedges
so `Restart=on-failure` heals Bruce, add `MemoryMax` (a leaky native audio
stack shouldn't take down the Pi), and review `RestartSec` backoff. Optional:
`WatchdogSec=` + `sd_notify` pings from the idle loop for a true liveness
check.

---

## Suggested next bites

Software-wise the backlog is now all P3 polish plus `#8` (single-round-trip
tool calls — worth trying once the mic/speaker are attached, since it needs
listening tests). The real next step is on the Pi: follow
deploy/README-bruce.md, then tune and enable barge-in
(`BRUCE_BARGE_IN_ENABLED=1`).

One thing to watch once the hardware is in: every tool definition is sent on
every Realtime session, and the list is now the hub's whole set (fetched by
src/functions/hub.js) plus the rig and reminders. If the model starts reaching
for the wrong function, the fix is sharper descriptions rather than fewer tools
— the pairs most likely to be confused are `get_brewery_status` (what it reads
now) against `get_sensor_history` (what it has been doing), and `manage_todo`
(a job with no time on it) against `set_reminder` (a particular moment).

Note that the descriptions to sharpen now live in
apps/server/src/bruce/tools.ts, not here — the only tools written in this
workspace are the rig's, reminders and the speaking volume.
