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
│   ├── web/           React app (/display and /admin)
│   │   └── src/
│   │       ├── pages/    Display.tsx, Admin.tsx
│   │       └── api.ts    Typed fetch client
│   └── bruce/         Voice assistant (wake word + OpenAI Realtime), runs as
│                      its own service on the Pi — see deploy/README-bruce.md
├── packages/
│   └── shared/        Types + Zod validation shared by server and web
├── knowledge/         Brewing books Bruce's chat answers from (see its README)
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

Features that call out to a paid API need a key. In development the server
reads a gitignored `.env` at the repo root (production uses
`/etc/brewplanner.env` instead, loaded by systemd):

```
OPENAI_API_KEY=sk-...      # Bruce's chat + `npm run knowledge`
```

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
| GET    | `/api/auth/me`                             | Current user + whether local-trusted |
| POST   | `/api/auth/login`                          | Log in (`{ username, password }`)    |
| POST   | `/api/auth/logout`                         | Clear the session                    |
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
| GET    | `/api/recipes`                             | List app-owned recipes               |
| POST   | `/api/recipes`                             | Create a recipe (admin)              |
| GET    | `/api/recipes/:id`                         | Read a full brew sheet               |
| PUT    | `/api/recipes/:id`                         | Save a recipe (admin)                |
| DELETE | `/api/recipes/:id`                         | Delete a recipe (admin)              |
| POST   | `/api/recipes/import/brewersfriend`        | Import new legacy recipes (admin)    |

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

### Recipes

Recipes are first-class BrewPlanner data stored in SQLite. Admins can create a
blank recipe, edit every field on its brew sheet (including ordered ingredient
lists, mash steps, and water targets), or delete it. Recipe ids created here are
UUIDs; imported Brewer's Friend recipes retain their old numeric ids so existing
keg links and bookmarks keep working. Ingredient weights, local catalogue costs,
shopping totals, fruit colour, and hop-rate stats are rebuilt from the stored
sheet whenever it is read.

The recipe builder follows the Brewer's Friend form structure: recipe setup,
style category and subcategory, fermentables, hops, other
ingredients, mash schedule, water chemistry, yeast/pitching, and calculation
outputs. Calculations always use Standard ABV, Tinseth IBU, Morey EBC, and
Lintner diastatic power. Style and ingredient fields are searchable comboboxes. Ingredient
results merge the local shop catalogues with names already used in saved
recipes, while still accepting a custom value. Gravity, FG, ABV, IBU, EBC, and
mash pH are recalculated from the recipe inputs on every save; ABV, IBU, and EBC
also show whether the batch is inside the selected 2021 BJCP style range.
New recipes start with one fermentable, hop, and yeast row and a 3 L/kg mash
thickness. Malt choices carry their catalogue EBC and hop choices their AA%;
fermentable quantities are entered in kilograms.

The first Recipes-page read after upgrading performs a one-way import when
`BREWERS_FRIEND_API_KEY` is configured. A manual import button can retry later;
existing ids are always skipped, so it never overwrites an app edit. Imported
recipes retain their original Brewer's Friend URL for reference, but all normal
reads and writes are local after import. The old API key is optional once the
legacy library has been brought across.

### Brew System page

`/brew-system` mirrors the brewing rig's (the separate brew-system-v3 Pi) main
screen — three pot cards, two pumps, and the brew timer — and controls it
remotely. The server proxies `/api/brew-system/*` to the rig's FastAPI over the
LAN (`BREW_SYSTEM_URL` in `/etc/brewplanner.env`, e.g. `http://192.168.1.60:8000`
— give that Pi a DHCP reservation). The rig's API is unauthenticated by design
(LAN-only), so this proxy is its only remote door: reads need a session,
controls need the admin role, and heater/pump commands land in the change
history. The rig is normally powered off between brew days — the page shows an
offline card and reconnects automatically. The rig's backend keeps running the
regulation loop, power limit, and safety watchdog itself, so a dropped remote
connection can never leave a heater unmanaged.

### Bruce — chat

The `/bruce` page is a written conversation with the brewery's assistant,
answered by the **server** — not by the voice service — so it works with no
microphone attached and `bruce.service` stopped.

Answers are grounded in the brewing books in `knowledge/` (see
`knowledge/README.md`). `npm run knowledge` splits each book into passages and
embeds them into a local index; a question is embedded the same way, the
closest passages are retrieved, and the model answers from those and cites the
book and page it read. When the books don't cover something it says so instead
of inventing a figure. Drop a `PROMPT.md` into `knowledge/` to replace Bruce's
written persona (e.g. with the instructions from an existing custom GPT).

He can also see and change the hub itself (`apps/server/src/bruce/tools.ts`):
what is in the fermenter and how it is fermenting, the Inkbird controllers,
which devices are online, the keg board, the to-do list, the alerts, and the
settings. Ask "how's the fermentation going?" and he looks rather than guesses.
The writing half covers the to-do list, the fermenter selection and clean/dirty
state, alert preferences, what a blank recipe starts from, the chart and keg
colours, the mock/real switch per sensor, and a device's logging interval or
setpoint. Recipes are deliberately read-only to him — a brew sheet is written in
the recipe editor.

These tools read the database directly (chat runs *inside* the server), so the
request-level audit hook can't see them — this route also answers as a hijacked
stream, so `onResponse` never fires. Each change therefore records its own
History entry, against the account that asked, prefixed `Bruce:`.

Needs `OPENAI_API_KEY` on the server — the same key the voice assistant uses.
Without it the page says so rather than failing when you type. Asking is
admin-only (each question costs API credit); reading a thread needs a session.
That guard is what keeps the tools safe: a read-only `guest` can open a thread
but cannot ask, so they cannot reach a change through him that they couldn't
make themselves.

Conversations are separate threads (`bruce_conversations` + `bruce_messages`),
switched from the menu in the chat header: start a new one per brew day or
topic, rename it, delete it. A thread names itself after its opening question.
Threads are shared, not per-account — a question asked on the phone is there on
the kiosk — and survive restarts.

**Web** in the chat header lets Bruce search the internet when the books are
silent — a hop released after they were written, a current price, a supplier.
Off by default, because the library is the point: left to the open web a model
will answer a mash-pH question from the first forum post it finds rather than
from Palmer. With it on he is still told to answer from the passages wherever
they cover the question, to say which part came from the web, and to prefer the
books where the two disagree. Web results are cited as links beside the book
chips. OpenAI runs the search (the `web_search` tool on `/responses`), so there
is no crawler here and no extra key — but each search is billed on top of the
tokens, and that fee is not in the per-thread estimates the page shows.

The model is chosen from a picker on the page, which explains what each one is
better and worse at rather than just listing ids. It offers a shortlist of five
picked for this job (see `SHORTLIST` in `apps/server/src/bruce/chat.ts` — edit
it to change the menu, blurbs included). Names are matched against the models
the API key can actually see, so a retired model drops out instead of breaking
the picker, and the list tops up from the account's newest models if the
shortlist ages out. The choice is stored in settings; `BRUCE_CHAT_MODEL` only
sets where a fresh install starts.

Billing is the OpenAI **API**, per token — a ChatGPT Plus/Pro subscription is a
separate product and does not cover it.

### Bruce — voice assistant

Bruce (`apps/bruce`, migrated from brew-system-v3) is a wake-word voice
assistant that runs on this Pi as its own systemd service (`bruce.service`).
Say "hey Bruce" near the microphone to control the rig (through the same audited
`/api/brew-system/*` proxy), check or update the keg inventory, hear fermenter
status, sensor readings and alerts, change controller setpoints, set brew-day
reminders, and run brewing calculators. He also reads the recipe library and
records which beer is in the fermenter, keeps the brewery to-do list, reports
the sensor fleet's health (online/offline, last seen, logging interval, IP) and
the Inkbird controllers at a glance, and reads or changes the settings — alert
preferences, new-recipe defaults, chart and keg colours, and the mock/real
switch per sensor. He calls the server over loopback
(trusted-local — no token) and speaks through OpenAI's GA Realtime API
(`gpt-realtime-mini`); the wake word is detected offline (openWakeWord, with a
custom-trained "hey Bruce" model). The
`/bruce` dashboard page shows his live state and conversation transcript, and
can set his volume or make him say something in the brewery (Bruce serves a
loopback status API that the server proxies as `/api/bruce/*`). One-time Pi
setup (audio hardware, API keys, enablement): `deploy/README-bruce.md`.

## Authentication & remote access

The app supports logging in and being reached from anywhere over the internet,
while the Pi's own touchscreen keeps working with no login.

- **Sessions** are signed, httpOnly cookies (`@fastify/cookie`). Passwords are
  hashed with scrypt (Node built-in — nothing to compile on the Pi). Accounts
  live in a real `users` table.
- **Roles**: each account is an **admin** or a **guest**. Admins can do
  everything (control devices, edit kegs, manage settings and other accounts);
  guests are read-only — they can view the dashboard and graphs but can't change
  anything, open the keg sheet, or see the Brew System page. Admins manage every
  account from **Settings → Accounts** (add/remove, switch role, reset password).
  The server enforces this on every mutating endpoint, not just in the UI.
- **Trusted-local bypass**: requests that hit the server directly on
  loopback/LAN *without* Cloudflare headers (the kiosk, LAN PCs) skip the login
  and are treated as admin-equivalent, so the physical touchscreen keeps full
  control. Requests arriving through the Cloudflare tunnel require a session.
  Force a login everywhere with `TRUST_LOCAL=false`.
- **First boot** seeds an `admin` user from `ADMIN_USERNAME` / `ADMIN_PASSWORD`,
  or generates a one-off password and logs it. Reset a password or create an
  account from the CLI with
  `npm run user -- <username> <password> [admin|guest]` (role defaults to
  `admin`; `npm run user -- list` shows each account's role).

In **local development** everything runs on localhost, which is trusted-local,
so `npm run dev` needs no login — the `/login` page only matters for remote
access.

| Env var          | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `SESSION_SECRET` | Signs session cookies. Auto-generated + persisted if unset.    |
| `ADMIN_USERNAME` | Initial admin username (first boot only). Default `admin`.     |
| `ADMIN_PASSWORD` | Initial admin password (first boot only).                      |
| `COOKIE_SECURE`  | Mark cookies Secure (auto-on when `NODE_ENV=production`).       |
| `TRUST_LOCAL`    | Set to `false` to require login even on the LAN/kiosk.         |

To expose the app at your own domain over HTTPS via a **Cloudflare Tunnel** (no
port-forwarding, home IP stays hidden), see
**[deploy/README-internet.md](deploy/README-internet.md)**.

## Raspberry Pi deployment

See **[deploy/README-pi.md](deploy/README-pi.md)** for the full appliance setup:
flashing Raspberry Pi OS Lite, setting the `checklist01.local` hostname,
installing the systemd services, and launching Chromium in kiosk mode with
`cage` (no desktop environment). For internet exposure + login, then follow
**[deploy/README-internet.md](deploy/README-internet.md)**.

## Roadmap

CSV exports, barcode scanner input, audit trail, plus the "other data and
sensors" integrations the dashboard is being prepared for. The structure
(shared contract, per-run history rows, single API surface, real users table)
is set up to add these without rework.
