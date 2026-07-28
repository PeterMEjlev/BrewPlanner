- Overview Page: fermenter temp graph doesnt show target temp when opened.

- Water Calculator page: review the water profile with the chat containing corrections
- Water Calculator page: review if water calc math is correct



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

Ordered by impact. Themes: unbounded data growth, hot polling paths doing repeated
full-table work, and tokens that never expire.

(Original #1 readings retention, #2 devices hot path, #3 keg-sheet cache, #4 token
expiry/revocation, and #10 polling pause were completed 2026-07-03. Item numbers
below are kept stable so cross-references still line up.)

## Backend

### 5. `getMetricTotal` re-scans the entire metric history every 60s
devices/repo.ts:239-249 runs a window function over the full history of
energy_kwh/water_l on every call; useDeviceTotal polls it every 60s per client.
- Incremental caching: keep {lastId, lastValue, total} per (device, metric) in
  memory; each call processes only `WHERE id > lastId`, adding positive deltas.
  Seed once at boot. Stays exact; steady-state cost is a few rows.

### 6. History polling refetches the full window every cycle
useDeviceData.ts:96-104 refetches up to 5000 rows every poll tick (as fast as 5s),
though only a few new points can exist. Over the tunnel that's hundreds of KB per
tick per open chart.
- The API already supports `since`: track newest recordedAt seen, poll with
  since=lastSeen, append to local state (full fetch only on metric/range change or
  error). Payloads drop from ~500KB to a few hundred bytes.

### 7. Static assets served with no cache headers, no compression on LAN
index.ts:104 registers @fastify/static with defaults, so the kiosk/phone
re-download the ~400KB recharts chunk on every load. Vite fingerprints filenames,
so /assets/* is safe to cache forever.
- setHeaders: `public, max-age=31536000, immutable` for /assets/*; `no-cache` for
  index.html (must revalidate).
- Add @fastify/compress — the LAN kiosk gets uncompressed 5000-row history JSON
  today (Cloudflare handles the tunnel side).

### 8. Small server hardening / robustness
- `PRAGMA synchronous = NORMAL` in db/index.ts:20 (default is FULL; NORMAL is the
  standard crash-safe WAL pairing and cuts fsync load on SD cards).
- Graceful shutdown: `process.on('SIGTERM', () => app.close())` + sqlite.close()
  so systemd restarts don't drop in-flight writes.
- @fastify/helmet for baseline security headers on the public tunnel hostname.

## Frontend

### 9. Every route change refetches `/auth/me` and blanks the screen
Each route wraps its own <RequireAuth> (main.tsx:52-257); the gate starts at
auth=null on every mount (auth.tsx:52), so every navigation shows "Loading…" until
/auth/me round-trips — noticeable over the tunnel.
- Cache last AuthState in module scope (pattern already used everywhere:
  cachedFleet, cachedKegs…): init from cache, render immediately when cached user
  exists, revalidate in background. Or hoist a single AuthProvider above the router.

### 11. Duplicate concurrent polls for the same resource
Module-level caches share results, but each hook instance runs its own interval —
two components showing the same series fetch it twice; DashboardShell polls
/api/devices every 15s while the Dashboard page polls the same endpoint separately.
- A small subscription store (key → one timer + subscriber set), OR adopt
  @tanstack/react-query (dedupe, retry/backoff, stale-while-revalidate) and
  delete most hand-rolled cache code in useDeviceData.ts and kegs.ts. (The
  hidden-tab pause that react-query would also have provided now exists as the
  shared usePoll hook — a subscription store could build on it.)

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

## Tooling

### 14. No tests and no CI
Not a single test file or workflow. Highest-value / lowest-effort targets: pure
functions in @checklist/shared and the web app — parseKegs CSV edge cases, the
gravity forecast fit (gravityForecast.ts), fermentationDone window logic, and the
notify/checks.ts thresholds (logic that silently misfires rather than crashing).
Server routes testable via app.inject() against a temp-file SQLite DB
(DATABASE_PATH already makes this injectable). Add vitest per workspace + a GitHub
Actions workflow running typecheck + tests + build on push (typecheck already
wired in root package.json).

## Next up by impact
#6 (history polling refetches the full window — the `since` param is already
there) and #9 (route changes blank the screen waiting on /auth/me).
