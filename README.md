# Checklist appliance

A minimal, future-proof touchscreen checklist device for a Raspberry Pi. An
operator taps steps on a fullscreen kiosk display to mark them complete; an
admin configures checklists from any PC on the same network.

- **`/display`** — fullscreen, touch-friendly operator view (the Pi opens this).
- **`/admin`** — desktop configuration UI (open from a PC).
- **`/api`** — JSON API used by both.

## Stack

| Layer     | Choice                                   |
| --------- | ---------------------------------------- |
| Frontend  | React + TypeScript + Vite + Tailwind CSS |
| Backend   | Node.js + TypeScript + Fastify           |
| Database  | SQLite (via Drizzle ORM)                 |
| Shared    | TypeScript types + Zod schemas           |
| Process   | systemd (server + Chromium kiosk)        |

## Project layout

```
.
├── apps/
│   ├── server/        Fastify API + serves the built web app in production
│   │   ├── src/
│   │   │   ├── db/        Drizzle schema, connection, migrations runner
│   │   │   ├── routes/    API route definitions
│   │   │   ├── repo.ts    Data access (all SQL lives here)
│   │   │   └── index.ts   Server bootstrap + SPA static serving
│   │   └── drizzle/      Generated SQL migrations
│   └── web/           React app (/display and /admin)
│       └── src/
│           ├── pages/    Display.tsx, Admin.tsx
│           └── api.ts    Typed fetch client
├── packages/
│   └── shared/        Types + Zod validation shared by server and web
└── deploy/            systemd units + Raspberry Pi setup guide
```

It's an npm-workspaces monorepo: one `npm install` at the root wires everything
together. The shared package is consumed by both apps so the API contract can't
drift.

## Prerequisites

- Node.js 20+ and npm 9+.

## Local development

```bash
npm install
npm run dev
```

`npm run dev` builds the shared package, then runs the API server (port 3000)
and the Vite dev server (port 5173) together. Open:

- Admin:   http://localhost:5173/admin
- Display: http://localhost:5173/display

Vite proxies `/api` to the server, so both pages talk to the same backend. The
SQLite file is created automatically at `apps/server/data/checklist.sqlite`.

## Production build (what runs on the Pi)

```bash
npm run build      # shared → web → server
npm run db:migrate # apply migrations (also runs automatically on server start)
npm start          # serves API + web on http://localhost:3000
```

In production the Fastify server serves the built React app itself, so
everything is on **one port (3000)**:

- Display: http://localhost:3000/display  (Chromium kiosk on the Pi)
- Admin:   http://checklist01.local:3000/admin  (from a PC on the LAN)

## Database & migrations

The schema is defined in
[apps/server/src/db/schema.ts](apps/server/src/db/schema.ts). After changing it:

```bash
npm run db:generate   # writes a new SQL migration into apps/server/drizzle/
npm run db:migrate    # applies pending migrations
```

Migrations are also applied automatically when the server boots, so a fresh
device just works. Data persists in the file at `DATABASE_PATH`
(default `apps/server/data/checklist.sqlite`).

## API reference

| Method | Path                                       | Purpose                              |
| ------ | ------------------------------------------ | ------------------------------------ |
| GET    | `/api/checklists`                          | List checklists (with step counts)   |
| POST   | `/api/checklists`                          | Create a checklist                   |
| GET    | `/api/checklists/:id`                      | Get a checklist with its steps       |
| PATCH  | `/api/checklists/:id`                      | Rename a checklist                   |
| DELETE | `/api/checklists/:id`                      | Delete a checklist                   |
| POST   | `/api/checklists/:id/activate`             | Make this checklist the active one   |
| POST   | `/api/checklists/:id/steps`                | Add a step                           |
| PATCH  | `/api/steps/:id`                           | Edit step text / required flag       |
| DELETE | `/api/steps/:id`                           | Delete a step                        |
| POST   | `/api/checklists/:id/reorder-steps`        | Reorder steps (`{ stepIds: [] }`)    |
| GET    | `/api/active`                              | Active checklist + current run state |
| POST   | `/api/runs/start`                          | Ensure a run exists for the active   |
| POST   | `/api/runs/reset`                          | Start a fresh run (clears progress)  |
| POST   | `/api/runs/current/steps/:stepId/toggle`   | Toggle a step in the current run     |
| GET    | `/api/todos`                               | List brewery to-do items             |
| POST   | `/api/todos`                               | Add a to-do item                     |
| PATCH  | `/api/todos/:id`                           | Edit text / toggle done              |
| DELETE | `/api/todos/:id`                           | Delete a to-do item                  |
| POST   | `/api/todos/clear-completed`               | Remove all completed to-do items     |

### Run model

A checklist's **current run** is simply its most recently created run. The
`/display` page auto-creates a run the first time it loads (`GET /api/active`),
so operators never see a "start" button — they just start tapping. **Reset**
creates a new run; old runs are kept as rows, leaving room for a future audit
trail without a schema change.

### Brewery to-do list

A separate, standalone list of ad-hoc brewery tasks — intentionally **not** a
checklist (no steps, runs or progress reset). On the `/display` page it lives
behind its own **To-Do** button in the top bar so it never gets mixed up with
procedure checklists; the button shows a badge with the open-item count.

## Raspberry Pi deployment

See **[deploy/README-pi.md](deploy/README-pi.md)** for the full appliance setup:
flashing Raspberry Pi OS Lite, setting the `checklist01.local` hostname,
installing the systemd services, and launching Chromium in kiosk mode with
`cage` (no desktop environment).

## Roadmap (intentionally out of scope for v1)

Reverse proxy + HTTPS, authentication / operator login, CSV exports, barcode
scanner input, audit trail. The structure (shared contract, per-run history
rows, single API surface) is set up to add these later without rework.
