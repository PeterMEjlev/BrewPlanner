# BrewPlanner context for Claude

Use this file as the first-pass project map. It intentionally describes stable
structure, contracts, and invariants instead of duplicating the full feature and
deployment documentation. Open only the task-relevant files linked below.

## What this project is

BrewPlanner is a self-hosted brewery hub, primarily deployed as a Raspberry Pi
touchscreen appliance. It combines checklists, recipes and brew-session history,
keg and fermenter state, sensor telemetry, alerts, brewing calculations, music,
a remote brewing-rig view, an Android app, and the Bruce brewing assistant.

The repository began as a checklist appliance. Consequently, several durable
names still use `checklist`: npm packages are `@checklist/*`, the default database
is `checklist.sqlite`, production services are `checklist-server.service` and
`checklist-kiosk.service`, and the Pi checkout is `/home/brewplanner/checklist`.
These are historical names, not separate products; do not rename them casually.

## Read efficiently

- Start with this file, then inspect only the relevant entry points/domain files.
- Do not scan `node_modules/`, build `dist/` directories, Android generated
  resources, `apps/server/drizzle/meta/`, binary assets, or the books under
  `knowledge/` unless the task specifically concerns them.
- `README.md` is the detailed feature/API overview. Use its headings rather than
  loading it wholesale for an unrelated change.
- `TODO.md` contains the current backlog and known structural hotspots; avoid
  copying its time-sensitive status into this file.
- Cross-project and network-infrastructure context may be in
  `C:\Sync\Knowledge Vault`. The separately deployed brew-system-v3 rig is not
  implemented in this repository.

## Repository map

```text
apps/
  web/       React 18 + TypeScript + Vite UI; also a Capacitor Android app
  server/    Fastify 5 + TypeScript API, SQLite/Drizzle persistence, schedulers
  bruce/     Standalone Node ESM voice service (plain JS, audio + Realtime API)
packages/
  shared/    API/domain types, Zod schemas, brewing calculations, shared constants
deploy/      systemd units, Pi/update scripts, and standalone Python sensor agents
knowledge/   Markdown brewing corpus used by Bruce's local retrieval index
prices/      Checked-in ingredient catalogue snapshots
guides/      End-user hardware setup guides
Icons/       Source device imagery; web-ready copies live in apps/web/src/assets
```

This is an npm-workspaces monorepo. The shared package must be built before the
web and server packages that consume its `dist` output.

## Runtime topology

```text
Browser / Pi kiosk / Capacitor app ------------------+
Python sensor agents (ingest + command polling) -----+--> Fastify server :3000 --> SQLite
Bruce voice service (hub tools/status on :3555) <----+          |                 (system of record)
                                                               +--> OpenAI / Google Drive / FCM
                                                               +--> Sonos + published keg sheet
                                                               +--> separate brew-system-v3 Pi (LAN proxy)
```

In development, Vite runs on port 5173 and proxies `/api` to Fastify on 3000.
In production, Fastify serves `apps/web/dist`, including the SPA fallback, so
the whole user-facing app is on port 3000. The kiosk normally boots `/kiosk`.

## Important entry points and ownership

| Concern | Canonical location |
| --- | --- |
| Server process and background schedulers | `apps/server/src/index.ts` |
| Fastify plugins, route mounting, static SPA | `apps/server/src/app.ts` |
| Local `.env` loading | `apps/server/src/env.ts` |
| Main human-facing API | `apps/server/src/routes/api.ts` |
| Device ingest, status, and command polling | `apps/server/src/routes/devices.ts` |
| Brewing-rig proxy | `apps/server/src/routes/brewSystem.ts` and `apps/server/src/brewSystemClient.ts` |
| Bruce HTTP/chat/voice surface | `apps/server/src/routes/bruce.ts` |
| Bruce hub tool implementations | `apps/server/src/bruce/tools.ts` |
| Database connection and migrations | `apps/server/src/db/index.ts` |
| Database schema | `apps/server/src/db/schema.ts` |
| General persistence | `apps/server/src/repo.ts` |
| Recipe and brew-session persistence | `apps/server/src/recipeRepo.ts`, `apps/server/src/brewSessions/repo.ts` |
| Audit and push-selection rules | `apps/server/src/audit/hook.ts` |
| Web router / page access gates | `apps/web/src/main.tsx` |
| Typed web API client | `apps/web/src/api.ts` |
| Native server URL/token handling | `apps/web/src/native.ts` |
| Cross-runtime API contract | `packages/shared/src/index.ts` |
| Recipe and mash-pH calculations | `packages/shared/src/recipeCalculations.ts`, `packages/shared/src/mashPh.ts` |
| Voice service entry/config | `apps/bruce/src/main.js`, `apps/bruce/config.js` |
| Sensor implementations | `deploy/agents/<sensor>-agent/agent.py` |

The main client-side routes are declared together in `apps/web/src/main.tsx`.
Pages live in `apps/web/src/pages/`; reusable UI is in `components/`. Several
page/component files and `packages/shared/src/index.ts` are deliberately large,
so search for the exact type, route, or feature before opening broad ranges.

## Persistence and external state

- SQLite is the application system of record. Development defaults to
  `apps/server/data/checklist.sqlite`; production sets `DATABASE_PATH` to
  `/home/brewplanner/data/checklist.sqlite`, outside the git checkout.
- `apps/server/src/db/index.ts` enables WAL, normal synchronous mode, and foreign
  keys, and applies pending migrations at server startup.
- Schema changes start in `apps/server/src/db/schema.ts`. Run `npm run db:generate`
  to create a migration under `apps/server/drizzle/`, inspect it, and commit it.
  Never rewrite an already-deployed migration to change current schema state.
- Recipes, sessions, devices/readings/commands, alerts/rules, audit history,
  Bruce conversations, settings, accounts, and ingredient overrides are local
  database data. Recipe JSON backups are generated separately.
- Keg reads come from a published Google Sheet and are cached by the server.
  Writes require the server-side `KEG_SHEET_WRITE_URL` Apps Script endpoint.
- `knowledge/*.md` is source material. The generated embedding index lives next
  to the database (or under `KNOWLEDGE_INDEX_DIR`) and is gitignored/rebuildable.
- Never commit real `.env` files, database/WAL files, session secrets, Firebase
  credentials, Google credentials, or generated knowledge indexes.

## Contracts and invariants

1. `apps/server/src/env.ts` must be the first import in server entry modules that
   transitively read environment variables at import time.
2. Put shapes crossing the server/web boundary and their Zod validation in
   `@checklist/shared`; keep server response, client API type, and schema changes
   synchronized. Server TypeScript source uses `.js` on relative ESM imports.
3. Validate untrusted request data with shared Zod schemas. UI route guards are
   convenience only; authorization must also be enforced by Fastify handlers.
4. The main `/api` plugin is authenticated. GETs are generally readable by a
   signed-in guest; mutations use `requireAdmin`. Direct trusted LAN/loopback
   traffic is admin-equivalent unless `TRUST_LOCAL=false`.
5. Sensor agents do not use user sessions. Each authenticates with its device
   bearer key, pushes `/api/ingest`, polls `/api/commands`, and acknowledges
   applied commands. `WATCH_API_TOKEN`, when configured, is separate read-only
   access for headless clients.
6. User-visible mutations normally belong in the audit history. The audit hook
   also defines which changes generate push notifications. Bruce tools execute
   inside the server and must explicitly audit their own direct database writes.
7. Keep process-level work (listen, timers, shutdown handlers) in server
   `apps/server/src/index.ts`, not `buildApp()`, so tests can use `buildApp()` without sockets or
   schedulers. Server integration tests set a temporary `DATABASE_PATH` before
   dynamically importing database-backed modules.
8. Recipe output is also a contract with the separate brew-system-v3 client.
   Preserve fields it consumes, notably pricing/cost, estimated colour, hop
   `stage`, and `timeUnit`. `predictBeerColor`, `estimateFermentationDays`, and
   keg recipe-to-content matching have counterpart implementations in that repo;
   coordinate compatible changes there when applicable.
9. The remote rig owns heater/pump safety and regulation. BrewPlanner proxies
   controls but must not duplicate or bypass the rig's safety loop.
10. Preserve offline behavior: the rig, Bruce service, Sonos, cloud APIs, push,
    backups, and optional imports may be unavailable without taking down the core
    local UI/API.

## Common commands

Run from the repository root unless noted.

```bash
npm install                  # install/link all workspaces
npm run dev                  # build shared, run server :3000 + Vite :5173
npm run build                # shared -> web -> server production build
npm run typecheck            # all workspaces with a typecheck script
npm test                     # shared/web Vitest + server node:test + Bruce tests

npm run db:generate          # generate SQL after schema changes
npm run db:migrate           # apply pending migrations
npm run user -- list         # account CLI; see README for mutations
npm run device -- --help     # device registration/management CLI
npm run knowledge            # build/update Bruce index; needs OPENAI_API_KEY
```

Useful targeted checks:

```bash
npm test --workspace @checklist/shared
npm test --workspace @checklist/web
npm test --workspace @checklist/server
npm test --workspace @checklist/bruce
npm run typecheck --workspace @checklist/server
npm run typecheck --workspace @checklist/web
```

There is no configured lint or formatting command. Follow surrounding style and
let TypeScript/tests catch contract drift. CI on `main` runs install, shared
build, typecheck, tests, and the full build using Node 22; the declared minimum
runtime is Node 20.

## Change workflow

1. Find the narrowest owning module from the table above; search before reading
   any large central file.
2. For API/domain changes, update shared types/schema first, then server, then
   the web client/UI. Add or adjust colocated `*.test.ts`/`*.test.js` coverage.
3. For persistence changes, generate and inspect a forward migration. Tests must
   use disposable databases; never point tests at the live/default production DB.
4. Run the smallest relevant tests and typecheck while iterating, then run
   `npm test`, `npm run typecheck`, and `npm run build` for cross-package or
   production-path changes.
5. Do not deploy, run update scripts, restart services, push, or modify the
   separate rig merely because a local change is complete. Deployment is an
   explicit follow-up action.

## Task-specific documentation

| Task | Read |
| --- | --- |
| Feature/API behavior and auth model | `README.md` relevant section |
| Fast local start or manual Pi update | `Quickstart.md` |
| First Pi install / systemd / kiosk | `deploy/README-pi.md` |
| Internet tunnel and SSH | `deploy/README-internet.md`, `deploy/README-ssh.md` |
| Automated app/rig update buttons | `deploy/README-brew-system-update.md`, deployment scripts |
| Sensor hardware and agents | `SENSORS.md`, then the matching `deploy/agents/*/README.md` |
| Bruce hardware/audio service | `apps/bruce/README.md`, `deploy/README-bruce.md` |
| Bruce books and indexing | `knowledge/README.md` |
| Recipe backups | `deploy/README-recipe-backup.md` |
| Android push notifications | `deploy/README-push.md` |
| Environment/configuration options | `deploy/brewplanner.env.example` |

When structure, ownership, commands, or invariants change, update this file in
the same commit. Keep feature prose and operational walkthroughs in their
specialist documents so this remains cheap to load.
