
- Buy bluetooth reciever and extension cable for TILT data inside fridge.

- Remove left-over bruce logic in BrewSystem3.0 repo

- make sure all notification settings that should be configurable are availabe in the settings/notifications page

- ## Add support for
  - Electricity (Watt) usage
  - Water usage 


git commit -m "Added critical notifiacations to phone app on severe issues. Removed telegram inteagration"



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
