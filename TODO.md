

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

---

# Optimization / improvement suggestions (code review)

Ordered by impact. Themes: unbounded data growth, hot polling paths doing repeated
full-table work, and tokens that never expire.

## Backend

### 1. `readings` grows forever — no retention or downsampling
No pruning anywhere. At a 5s interval one metric writes ~17k rows/day; a few
devices × metrics = tens of millions of rows/year in one SQLite file on the Pi's
SD card. Every `count(*)`, total, and long-range history query slows down, and SD
wear increases.
- Add a nightly maintenance job (same scheduler pattern as index.ts:134).
- Create a `readings_rollup` table (deviceId, metric, bucketStart, avg, min, max);
  fold readings older than ~30 days into 5-min buckets, then delete raw rows.
- Have `getHistory` (devices/repo.ts:252) serve raw rows for short ranges and
  rollups for 7d+ (charts can't display 100k points anyway).
- Simpler v1: `DELETE FROM readings WHERE recorded_at < ?` with a 90-day cutoff,
  plus `PRAGMA incremental_vacuum`.

### 2. `/api/devices` does a full `count(*)` per device on every poll
enrich() (devices/repo.ts:184-191) runs readingCount (count(*) over all readings),
latestPerMetric (2 queries), and pendingSetpoint (1 query) PER device. The nav
badge (DashboardShell.tsx:113) polls this every 15s from every open client; the
Devices page polls as fast as every 5s. better-sqlite3 is synchronous, so these
counts block the event loop, and the cost grows with #1.
- Keep the count in memory: one grouped query on boot into a Map<deviceId, count>,
  increment in insertReadings, delete on device delete. Turns the hot path from
  O(rows) into O(1).
- latestPerMetric for all devices can be one grouped query instead of 2×N.

### 3. Every `/api/kegs` request fetches the Google Sheet live
kegs.ts:20-24 has no cache; the shell's keg badge polls it every 15s per client
(DashboardShell.tsx:169). A Google round trip every 15s per open dashboard — slow,
rate-limit-prone, and a single Google hiccup errors the badge.
- Add a module-level TTL cache (~60s) with in-flight dedupe and stale-on-error.
- Apply colours post-cache (or cache the raw CSV text) so callers can pass
  different palettes.

### 4. Sessions and bearer tokens never expire server-side and can't be revoked
Session cookie and Android bearer token are both just signCookie(String(userId))
(auth/index.ts:124). The 30-day maxAge is only browser-enforced; the signature
carries no timestamp. So: a leaked token / lost phone grants access forever,
changing your password does NOT invalidate existing sessions, and logout only
clears the client copy.
- Embed issued-at: sign `${userId}.${Date.now()}`, reject tokens older than
  SESSION_MAX_AGE_SECONDS in getSessionUser/getBearerUser.
- Add a `tokenVersion` column to users, include in payload
  (`${id}.${issuedAt}.${version}`), bump it in changeUserPassword — kills every
  outstanding cookie/token for that account on password change.

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

### 10. Polling never pauses when the app is hidden
~16 independent setInterval poll loops (DashboardShell, useDeviceData, Alerts,
Display, KioskMusic at 4s…). None pause when the tab is hidden or the Android app
is backgrounded — a phone with the app backgrounded hammers the tunnel and drains
battery.
- Extract one shared usePoll(fn, ms) hook: skip ticks while
  document.visibilityState === 'hidden', fire immediately on return to visible.
  In native, wire Capacitor App 'appStateChange'. Replaces 16 copies of
  interval/cancelled/cleanup boilerplate.

### 11. Duplicate concurrent polls for the same resource
Module-level caches share results, but each hook instance runs its own interval —
two components showing the same series fetch it twice; DashboardShell polls
/api/devices every 15s while the Dashboard page polls the same endpoint separately.
- A small subscription store (key → one timer + subscriber set), OR adopt
  @tanstack/react-query (dedupe, refetchIntervalInBackground:false [solves #10],
  retry/backoff, stale-while-revalidate) and delete most hand-rolled cache code in
  useDeviceData.ts and kegs.ts.

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

## If picking three first
1. Readings retention (#1) — before the table gets big enough to hurt.
2. Token expiry/revocation (#4) — the app is internet-reachable.
3. Keg-sheet cache (#3) — cheapest win.