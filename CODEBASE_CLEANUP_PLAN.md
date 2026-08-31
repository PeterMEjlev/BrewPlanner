# Codebase Cleanup and Consolidation Plan

Audit date: 2026-08-31

This is an implementation plan only. No application source was changed during the audit. The working tree already contained unrelated edits before the audit; those edits were treated as user-owned and were not used as evidence that a symbol is dead.

Evidence gathered for this plan included repository-wide text and import/export searches, entry-point and route tracing, strict TypeScript checks with unused-symbol diagnostics enabled, Knip analysis, JavaScript/Python syntax and import inspection, exact-file hashing, CSS selector-to-JSX searches, asset/config/script inspection, and the repository test suites. Results from static tools were checked against dynamic loading, framework conventions, tests, scripts, deployment files, and runtime directory scans before being classified.

# 1. Executive Summary

The codebase is generally coherent and has clear runtime boundaries: a Fastify/SQLite server, a React/Capacitor client, a shared domain package, a standalone Bruce voice service, and deployment-side sensor agents. Routing is explicit, server persistence has a single owner, API schemas are centralized, database migrations are dynamically consumed, and most apparently unreferenced assets are in fact used through web manifests, Android resource conventions, deployment scripts, or runtime directory scanning. These areas should remain intact.

The highest-value cleanup is consolidation rather than wholesale deletion:

1. Move brewing calculation primitives duplicated between the web tools and Bruce server tools into `@checklist/shared`.
2. Centralize repeated client device-role classification and fermenter-status polling.
3. Replace three near-identical server-backed client stores with one small store factory while retaining domain-specific public modules.
4. Share the service-account JWT/token implementation used by Google Drive and Firebase Cloud Messaging.
5. Extract the common lifecycle in the five Python sensor agents without erasing their hardware-specific behavior.
6. Move the shared update-status contracts into the shared package and consolidate only the common status-file/log-reading mechanics.

There is also a useful, low-risk dead-code pass: remove an obsolete browser mock, committed generated files and bytecode, an orphan screenshot and favicon, Android template tests, eight unused imports/locals, four unused shared constants, a set of unused schema-derived type aliases, and unnecessary public export modifiers. No declared direct dependency is currently proven unused.

Risk is concentrated in four places: production authentication/token handling, hardware agents, update orchestration, and checked-in recipe backups. These should be handled in isolated changes with targeted tests. Database migrations, historic `checklist` package names, Android resource duplicates, Bruce models/audio, knowledge files, and price data are intentional and should not be cleaned up merely because ordinary imports do not point to them.

One pre-existing validation issue should be resolved before cleanup begins: `apps/server/src/commandPoll.test.ts` is cancelled by Node's test runner when it reaches the timeout-only case. `waitForCommand()` deliberately calls `timer.unref()` in `apps/server/src/devices/notify.ts`, leaving no referenced event-loop handle in that isolated test. Preserve the production shutdown behavior; make the test deterministic or make timer behavior injectable for tests.

# 2. Codebase Structure Observed

| Area | Current role and data flow |
|---|---|
| `apps/server/src/index.ts`, `apps/server/src/app.ts` | Fastify bootstrap and application assembly. The server owns authentication, SQLite/Drizzle repositories, device ingestion/commands, schedulers, Bruce endpoints, music endpoints, rig proxying, and serving the built web client. |
| `apps/server/src/routes/` | Explicitly registered API route groups. Route discovery is not convention-based, so registration and imports were traced directly. Device-agent routes and authenticated user routes have different authentication paths. |
| `apps/server/src/db/`, `apps/server/drizzle/` | SQLite is the system of record. Drizzle migrations and metadata are runtime/build inputs and must remain complete and immutable. |
| `apps/web/src/main.tsx` | React entry point and explicit lazy route table. Pages found here are live even when Knip cannot infer a runtime transition to them. |
| `apps/web/src/pages/`, `apps/web/src/components/` | Page-level orchestration and reusable presentation. State is mostly React-local, query/poll based, or exposed through small `useSyncExternalStore` modules; there is no monolithic state framework. |
| `apps/web/android/` | Capacitor Android project. Manifest/resource-qualifier and Gradle convention usage must be considered before deleting files. |
| `packages/shared/src/index.ts` | Canonical API/domain schemas, types, defaults, recipe calculations, and brewing constants consumed by server and web. It is deliberately broad; splitting it solely by line count would add churn without removing duplication. |
| `apps/bruce/src/main.js` and `apps/bruce/src/` | Standalone CommonJS voice process using OpenAI Realtime, ONNX wake-word models, audio processing, and a registration-based tool/module hub. CommonJS registration produces static-analysis false positives and requires manual tracing. |
| `deploy/agents/*/agent.py` | Five standalone Raspberry Pi/device agents. They post authenticated readings and consume interval/command responses. Hardware acquisition differs, but their scheduling, retry, logging, and shutdown lifecycle is repeated. |
| `deploy/`, `scripts/` | systemd, install/update, backup, and operational scripts. Several files are used only by services or deployment documentation rather than application imports. |
| `knowledge/`, `prices/` | Runtime-scanned content. These files are data inputs, not dead assets, even though there are no per-file imports. |

Important intentional boundaries:

- Mobile and desktop keg UIs differ in interaction model; their existence is not accidental duplication.
- Server repository functions and fallback/device facades may share names but have different ownership responsibilities.
- Local rig update and remote brew-system update triggers have different safety and process semantics.
- Historic `@checklist/*` names are established workspace/API identifiers, not evidence of obsolete checklist functionality.
- Root `Icons/`, web icon derivatives, Android density/resource variants, Drizzle migration history, Bruce models/WAVs, knowledge documents, and price JSON are all indirectly or conventionally used.

# 3. Confirmed Unused Code

## 3.1 Unused files and assets

| Path | Why it is confirmed unused / evidence | Recommended action | Risk |
|---|---|---|---|
| `apps/web/src/mockDevices.ts` | No repository import or dynamic reference. Its own comment says mock ownership moved to the server; active fallback code imports `apps/server/src/devices/mock.ts`. It is absent from the web route and build entry graph. | Delete the file. | Low |
| `apps/server/drizzle.config.js` | Generated CommonJS output committed alongside the authoritative `drizzle.config.ts`. Drizzle's config lookup prefers the present TypeScript config; package scripts do not name the JS file. | Delete it and keep `drizzle.config.ts`. | Low |
| `apps/server/drizzle.config.d.ts` | Generated declaration for the unused generated JS config; Knip also reports it as an unused file. | Delete it. | Low |
| `apps/server/drizzle.config.js.map` | Source map referenced only by the generated JS file being removed. | Delete it. | Low |
| `apps/web/scripts/__pycache__/generate-icons.cpython-312.pyc` | Python bytecode generated from the tracked script; no runtime should consume a repository bytecode cache. | Delete and ignore `__pycache__/` and `*.py[cod]`. | Low |
| `deploy/agents/inkbird-agent/__pycache__/agent.cpython-312.pyc` | Generated Python bytecode; the systemd/deployment path uses `agent.py`. | Delete and ignore bytecode. | Low |
| `deploy/agents/power-agent/__pycache__/agent.cpython-312.pyc` | Generated Python bytecode; deployment uses source. | Delete and ignore bytecode. | Low |
| `deploy/agents/pressure-agent/__pycache__/agent.cpython-312.pyc` and `agent.cpython-313.pyc` | Generated caches for two local Python versions; neither is a deployable source artifact. | Delete and ignore bytecode. | Low |
| `deploy/agents/tilt-agent/__pycache__/agent.cpython-312.pyc` | Generated Python bytecode; deployment uses source. | Delete and ignore bytecode. | Low |
| `deploy/agents/water-agent/__pycache__/agent.cpython-312.pyc` | Generated Python bytecode; deployment uses source. | Delete and ignore bytecode. | Low |
| `shot.png` | An old recipe-editor screenshot at the repository root. It is not referenced by Markdown, code, manifests, scripts, or build config and is outside served asset directories. | Delete it. | Low |
| `apps/web/public/favicon-96.png` | Generated by `generate-icons.py`, but not referenced by `index.html`, `manifest.webmanifest`, Android resources, code, or config. Other favicon/PWA sizes are explicitly referenced. | Delete the file and its generation entry. | Low |
| `apps/web/android/app/src/test/java/com/getcapacitor/myapp/ExampleUnitTest.java` | Untouched Capacitor template test in the template package; it only asserts `2 + 2 == 4` and tests no application code. | Delete it. | Low |
| `apps/web/android/app/src/androidTest/java/com/getcapacitor/myapp/ExampleInstrumentedTest.java` | Untouched template test in the wrong package and asserts the obsolete `com.getcapacitor.app`; the actual application ID is `com.konfus.app`. | Delete it; add a real smoke test separately only if Android instrumentation is part of CI. | Low |

## 3.2 Unused imports, parameters, and locals

These eight diagnostics were produced by repository TypeScript configurations augmented with `--noUnusedLocals --noUnusedParameters`, then confirmed by symbol search. Normal `npm run typecheck` passes because the repository does not currently enable these checks.

| Path | Symbol | Evidence and action | Risk |
|---|---|---|---|
| `apps/server/src/bruce/repo.ts` | imported `lt` | No use after import. Remove it from the Drizzle import list. | Low |
| `apps/server/src/devices/mock.ts` | `profile` parameter of `targetSetAt` | Never read in the function body and no overload/interface requires the arity. Remove the parameter and update its local call sites. This file had pre-existing working-tree edits, so merge carefully. | Low |
| `apps/server/src/routes/api.ts` | imported `recipeEditSchema` | Unused in this route module; the schema itself is live elsewhere. Remove only this import. | Low |
| `apps/web/src/pages/Dashboard.tsx` | imported type `Reading` | No type position uses it. Remove only this import. This file had pre-existing working-tree edits. | Low |
| `apps/web/src/pages/KegsDesktop.tsx` | local `filled` | Assigned but never read. Remove the binding and any computation that exists only to produce it. | Low |
| `apps/web/src/pages/KioskHome.tsx` | imported type `Reading` | No type position uses it. Remove only this import. | Low |
| `apps/web/src/pages/SettingsDesktop.tsx` | imported `DEFAULT_GRAPH_COLORS` | No reference after import. Remove only this import. | Low |
| `apps/web/src/pages/WaterCalculator.tsx` | imported `DEFAULT_LIMITS` | No reference after import. Remove only this import. | Low |

## 3.3 Dead symbols and unnecessarily public exports

### Symbols with no repository consumer

| Path | Symbol | Evidence and action | Risk |
|---|---|---|---|
| `packages/shared/src/index.ts` | `EMPTY_BREW_SESSION_MEASUREMENTS` | Its declaration is its only identifier occurrence across tracked source. Delete it. | Low |
| `packages/shared/src/index.ts` | `INGREDIENT_KINDS` | Its declaration is its only identifier occurrence. Delete it unless it is first adopted to replace a separate live list. | Low |
| `packages/shared/src/index.ts` | `KEG_CONTENT_COLORS` | Declaration-only alias of `DEFAULT_KEG_CONTENT_COLORS`; Knip also reports the duplicate export. Delete the alias, retain the default constant. | Low |
| `packages/shared/src/index.ts` | `CUSTOM_ALERT_TEST_KINDS` | Its declaration is its only identifier occurrence. Delete it. | Low |
| `apps/server/src/system/update.ts` | `currentManifest` | No call or import; declaration-only according to Knip and repository search. Delete it after confirming any adjacent test does not intend to exercise it. | Low |
| `apps/web/src/components/charts.tsx` | `measured` | No import or in-file call. Delete it. | Low |
| `apps/web/src/components/RingGauge.tsx` | `RingGauge` | No render/import found in routes, pages, components, or tests. Delete the component file if it contains no other live export. | Low |
| `apps/web/src/components/icons.tsx` | `BeerMugIcon` | Export declaration is the only use. Delete it. | Low |
| `apps/web/src/recipeData.ts` | `YEAST_TYPES` | Export declaration is the only use. Delete it. | Low |
| `apps/web/src/water.ts` | re-export `gristDistilledMashPh` | The shared implementation is live elsewhere, but this web-layer re-export has no consumer. Remove only the re-export. | Low |
| `apps/server/src/auth/index.ts` | re-export `hashPassword` | Consumers import the live implementation through its owning password module; no consumer uses this barrel re-export. Remove only the re-export. | Low |

The following Zod-inferred aliases in `packages/shared/src/index.ts` have no named import, re-export, annotation, or other identifier occurrence anywhere in the repository. Their corresponding schemas are live and must remain. Delete only the aliases:

`StartBrewSessionInput`, `AlertsQuery`, `LoginInput`, `CreateChecklistInput`, `UpdateChecklistInput`, `CreateStepInput`, `UpdateStepInput`, `ReorderStepsInput`, `CreateTodoInput`, `UpdateTodoInput`, `CreateTodoCategoryInput`, `UpdateTodoCategoryInput`, `ReorderTodosInput`, `CreateDeviceInput`, `IngestInput`, `HistoryQuery`, `MetricTotalQuery`, `SetpointChangesQuery`, `SetSetpointInput`, `SetReportingIntervalInput`, `AckCommandsInput`, `CommandPollQuery`, `DeviceDataSourcesInput`, `SetActiveRecipeInput`, `FermenterStateInput`, `NotificationSettingsInput`, `PushTokenInput`, `KegContentColorsInput`, `GraphColorsInput`, `ChangePasswordInput`, `ChangeUsernameInput`, `CreateUserInput`, `SetUserRoleInput`, `AdminSetPasswordInput`, `BrewTimerActionInput`, `BrewStageActionInput`, `BruceSpeakInput`, `BruceVolumeInput`, `BruceWakeAckInput`, `BruceWakeWordGainInput`, `BruceChatInput`, `BruceConversationInput`, `BruceChatModelInput`, `BruceWebSearchInput`, `BruceVoiceToolInput`, `BruceVoiceTurnInput`, `BruceKnowledgeFileInput`, `BruceReindexInput`, and `BruceInstructionsInput`.

Risk for removing these aliases is **Low within this private monorepo**. Before deletion, run one final search in any separately deployed repository that imports `@checklist/shared`; the current repository and workspace package graph contain no consumer.

### Live symbols that do not need to be exported

Knip reports the following exports as unused outside their defining module. Manual inspection shows that most symbols are used internally, so deleting them would be wrong. Remove only the `export` modifier, which reduces accidental API surface without changing runtime behavior.

- Server: `SESSION_COOKIE`, `getBearerUser`, `mintAuthToken`, `RecipeNotFoundError`, `listRecipes`, `listRecipeStats`, `getRecipe`, `sampleRigForBrewSessions`, `chatPrompt`, `renderRecipe`, `CRITICAL_SENSOR_KEYS`, `CHARS_PER_TOKEN`, `USD_PER_MTOK`, `invalidateIndex`, `buildRecipeBackup`, plus types `BrewSystemUpdateState` and `UpdateState` after the shared update contract is introduced.
- Web: `DEFAULT_RANGE_MS`, `BREW_SYSTEM_POLL_MS`, `fieldClass`, `scaleSpan`, `panSpan`, `BADGE_LINE`, `DEFAULT_MASH_THICKNESS_L_PER_KG`, `getGraphColors`, `getKegContentColors`, `fetchKegs`, `kegAgeDays`, `getRecipeDefaults`, `DEFAULT_SETTINGS`, `getSettings`, `BAR_PER_PSI`, `listPollMs`, and `dilute`, plus types `SparkTooltipRow`, `SearchableOption`, and `KegAgeStatus`.

Some reported exports are better handled by the consolidation work rather than mechanically privatized: `DEFAULT_GRAPH_COLORS`, `DEFAULT_KEG_CONTENT_COLORS`, `DEFAULT_SETTINGS`, and shared update status types should have one explicit canonical owner. Risk is **Low**, provided a full type check and Knip pass follows each batch.

# 4. Potentially Unused Code Requiring Verification

| Candidate | Why it is suspicious | Verification required before action | Provisional action / risk |
|---|---|---|---|
| `apps/server/data/recipe-backups/brewplanner-recipes-20260728T203817915Z.json` and `brewplanner-recipes-20260730T203951313Z.json` | Runtime code creates recipe backups but does not read these two checked-in snapshots as fixtures or seed data. They look like production/recovery artifacts accidentally committed. | Confirm both snapshots are retained in the configured Drive/production backup location, confirm no manual recovery runbook points to the repository copies, and compare hashes/record counts. | If confirmed, remove from version control and ignore the runtime `recipe-backups/` directory while preserving deployed backups. **High** because deletion could remove the only recovery copy. |
| `BREW_DAY_SAMPLE_SECONDS` fallback in the brew-session sampler | It is a legacy environment-variable name retained after migration to `BREW_SESSION_SAMPLE_SECONDS`. | Inspect `/etc/brewplanner.env`, service overrides, Pi/production secrets, and deployment automation on every installation. Search outside this repository as well. | Remove the alias only after all deployments use the new name for at least one release. **Medium**. |
| CommonJS named export aliases in `apps/bruce/src/` such as `module.exports.BruceAssistant`, `GainControl.DEFAULTS`, and the exported `SKIP` sentinel | Repository runtime uses the default `BruceAssistant` export and module registration; these additional properties have no local consumer, but CommonJS property access is harder for static tools to prove and external debug scripts may use them. | Search operational scripts and any separate Bruce repository, then run all Bruce tests and the real startup command. | Remove only confirmed aliases, not module `register`/`registerOnce` entry points. **Medium**. |
| Public exports from `@checklist/shared` that are unused in this workspace | The package is private and all in-repo consumers were searched, but TODOs mention a separate brew-system project. | Search the deployed/adjacent brew-system source before shrinking shared public surface. | Prefer a deprecation release if an external consumer exists. **Medium**. |
| `TODO.md` item referring to Bruce work in `Desktop/Bruce-v2` and the server TODO referring to `brew-system-v3` | No matching project was found in this repository or the project knowledge vault, so completion/abandonment cannot be established. | Locate those external repositories or deployment notes and confirm current ownership. | Keep but rewrite with an explicit external-project path/owner if still active. **Low**. |

Files considered but explicitly **not** classified as unused include `IP.md`, root icon sources, Android adaptive/splash resource duplicates, `MainActivity`, all Drizzle migrations and metadata, knowledge documents, prices, Bruce ONNX/WAV assets, service/install scripts, and Brewer's Friend integration code. Their use is operational, configuration-driven, conventional, or feature-gated.

# 5. Duplicate and Redundant Code

## 5.1 Client device-role and fermenter-status logic

**Locations:** `apps/web/src/components/MetricChart.tsx`, `apps/web/src/pages/Dashboard.tsx`, `Devices.tsx`, `KioskDevice.tsx`, and `KioskHome.tsx`.

- `isBreweryTempDevice` is repeated five times; `isKegsTempDevice` appears three times; `isFermenterDevice` and `latestDeviceTimestamp` appear in both Dashboard and Devices.
- `groupByName`, `groupRank`, `findReading`, and the device type rank table are duplicated between Dashboard and KioskHome.
- Dashboard and KioskHome independently fetch/poll fermenter history and derive almost the same online/fermenting/complete state. Dashboard additionally has a cross-remount cache and page-specific shell classes; Kiosk has different styling.

Create a web-only pure module such as `apps/web/src/deviceRoles.ts` for classification, ranking, latest-reading selection, and stable group helpers. Create `apps/web/src/hooks/useFermentStatus.ts` that returns semantic state (`offline`, `online`, `fermenting`, `complete`) and readings; let each page map state to its existing CSS. Preserve Dashboard's cache behavior through an explicit hook option or shared cache rather than silently dropping it. Remove local implementations and update the five import sites. The pure functions and polling transitions need focused tests. Risk: **Medium**, because a classification change affects charts, dashboard grouping, and kiosk status simultaneously.

## 5.2 Brewing calculations duplicated across client and server

**Locations:** `apps/web/src/tools.ts` and calculator code in `apps/server/src/bruce/tools.ts`.

Both implement dilution volume, corrected hydrometer gravity, carbonation pressure, numeric parsing/normalization, and style/guideline data. Comments already warn that formulas must be mirrored. Differences are meaningful only at the boundary: Bruce accepts conversational gravity formats and produces tool-specific errors/prose; the web functions accept form values.

Move the pure numeric primitives and numeric carbonation guidelines into `@checklist/shared` (a dedicated `brewingTools.ts` is appropriate if `index.ts` would become harder to navigate). Keep input normalization, Zod/tool validation, and user-facing text in the callers. Have `apps/web/src/tools.ts` re-export or wrap the shared functions temporarily to minimize import churn, then update direct consumers. Remove the server's copied formula bodies. Promote formula edge cases into shared tests and retain Bruce response tests. Risk: **Medium**; floating-point and unit behavior must remain byte-for-byte compatible for existing inputs.

## 5.3 Repeated server-backed client stores

**Locations:** `apps/web/src/graphColors.ts`, `kegContentColors.ts`, and `recipeDefaults.ts`.

Each module repeats an in-memory cache, hydration flag, listener set, emit/hydrate/subscribe functions, `useSyncExternalStore`, optimistic saves, resets, and silent load-failure handling. The value types and endpoints differ; the state machine does not.

Create a narrowly typed `createServerStore<T>()` helper configured with default value, load, and save functions. Preserve each existing domain module as the public facade and keep domain helpers such as `metricColor` next to their domain. Preserve current optimistic update ordering and failure semantics explicitly. Do not include `settings.ts` (localStorage) or rig theme state in the first pass; their persistence/error semantics differ. Remove only the duplicated store plumbing. Risk: **Medium**.

## 5.4 Google service-account authentication

**Locations:** `apps/server/src/googleDrive.ts` and `apps/server/src/notify/push.ts`.

Both parse service-account JSON, base64url-encode JWT parts, sign an RSA assertion, exchange it at Google's OAuth endpoint, cache the token, and refresh before expiry. Drive additionally supports refresh-token OAuth; FCM requires `project_id`; error policies and environment names differ.

Extract a server-internal `googleAuth.ts` that validates service-account credentials and mints/caches a token keyed by credentials plus scope. Leave Drive refresh-token support, FCM project selection, optional-feature handling, logging, and endpoint-specific errors in their callers. Remove duplicated crypto/token code only after mocked tests cover signature inputs, scope isolation, expiry skew, malformed credentials, and failed token responses. Risk: **High** due to authentication and notification/backup impact.

## 5.5 Zod request parsing in route modules

**Locations:** `apps/server/src/routes/api.ts`, `devices.ts`, `brewSystem.ts`, `bruce.ts`, and `music.ts`.

These files repeat nearly identical `parse` helpers and a common HTTP 400 error body. Small generic differences exist because some schemas coerce/default input.

Create `apps/server/src/routes/parse.ts` using `S extends z.ZodTypeAny` and returning `z.output<S>`. Preserve the exact current error response shape. Replace local helpers/imports, then delete them. Test coercion, defaults, nested validation errors, and the 400 response before migrating all route groups. Risk: **Low**.

## 5.6 Sensor-agent lifecycle

**Locations:** all `deploy/agents/*/agent.py` files.

All five repeat UTC timestamping, logging, MAC lookup, authenticated posting, server-provided interval updates, buffered retry, next wall-clock slot calculation, interruptible sleeping, signal shutdown, and main-loop scaffolding. Power, water, and pressure are closest; Tilt and Inkbird have distinct scanning/command concerns.

Extract `deploy/agents/common.py` or a small deployable package containing only lifecycle/network/scheduling primitives with callback-based sensor reads. Keep hardware imports and acquisition logic in each agent; keep Inkbird command handling separate. Update install/copy/service documentation so the shared module is always deployed with the agent. Remove copied lifecycle helpers after simulate-mode and device tests pass. Risk: **High** because deployment packaging and offline retry behavior are hardware-facing.

## 5.7 Local and remote update status handling

**Locations:** `apps/server/src/system/update.ts`, `system/brewSystemUpdate.ts`, and duplicated response interfaces in the web API layer.

Both server modules define similar state/status shapes and repeat status-file parsing and log-tail assembly. Their triggers should remain separate: local update hands off to systemd, whereas remote rig update has detached execution, safety preflight, and stale-state detection.

Move wire response types into `@checklist/shared`. Extract only a server-internal status-file/log utility, parameterized by paths and state validation. Keep both trigger workflows and their safety rules in their existing modules. Replace duplicate web interfaces with shared types. Risk: **Medium**.

## 5.8 Mock-device identity constant

**Locations:** `apps/server/src/devices/mock.ts`, `apps/web/src/pages/Devices.tsx`, and `SettingsDesktop.tsx`.

The magic base ID `900000` is repeated and the client infers mock identity from the range. Move the constant and an `isMockDeviceId()` helper into `@checklist/shared` as the behavior-preserving first step. A future explicit `isMock` response field would be clearer but is an API change and should not be mixed into cleanup. Remove local constants and update imports. Risk: **Low**.

## 5.9 Money formatting

**Locations:** `apps/web/src/components/PricePicker.tsx` and `apps/web/src/money.ts`.

`PricePicker` defines a local `kr` formatter identical to the canonical money utility. Import the shared web formatter, remove the local copy, and retain existing locale/rounding tests or snapshots. Risk: **Low**.

## 5.10 Ingredient-unit conversion

**Locations:** `apps/server/src/brewerfriend.ts` and `apps/server/src/recipeData.ts`.

Both define grams/count conversion with slightly different accepted types and missing-unit behavior. `recipeData.ts` also supports ml/l conversion for miscellaneous ingredients.

Extract a common server utility for normalized weight-to-grams and unit/count conversion with an explicit missing-unit policy. Keep the `other` volume extension in recipe data and keep import-specific validation in Brewer's Friend. Remove local copies only after tests compare representative imported recipes with stored recipes. Risk: **Medium**.

## 5.11 Bruce PCM RMS calculation

**Locations:** `apps/bruce/src/engine/index.js` and `apps/bruce/src/AudioEchoCanceller.js`.

The `_computeRMS` implementation is identical. Move the pure PCM calculation to the existing audio utility area, import it in both classes, and test empty, clipped, and ordinary buffers. Remove the two method bodies. Risk: **Low**.

## 5.12 Repeated password-visibility icons

**Locations:** `apps/web/src/pages/Login.tsx` and `SettingsDesktop.tsx`.

Local Eye/EyeOff SVG components are repeated. Move them to the existing `components/icons.tsx` only if their view boxes, accessibility behavior, and styling inputs are identical; otherwise keep them local. This is low-value and should follow higher-impact work. Risk: **Low**.

# 6. Consolidation Opportunities

## 6.1 Decompose the two largest orchestration pages along feature boundaries

`apps/web/src/pages/Dashboard.tsx` and `SettingsDesktop.tsx` combine multiple independent panels, API effects, formatting helpers, and dialog state. The current TODO line counts are stale, but the architectural concern remains valid.

After device-role and store consolidation, extract stable boundaries rather than tiny presentation fragments:

- Dashboard: `FermenterCommandCenter`, brewery utilities/cards, `KegInventoryPanel`, `BrewSystemCard`, `KegFridgeCard`, and pure metric formatters. Keep route-level data coordination and responsive layout in `DashboardPage`.
- Settings: Display, Bruce, Sensors, Brewing, Notifications, Accounts, Updates, and Reset sections, backed by shared local `Card`, `Row`, and segmented-control primitives where markup is actually identical.

Move one panel at a time without changing requests, polling cadence, state ownership, DOM labels, or CSS class names. Add component tests around callbacks and conditional states. Risk: **Medium**.

`Bruce.tsx` and `RecipeEditor.tsx` are also large, but are more cohesive. Consider later extraction only for clearly state/API-isolated Chat/Voice/Knowledge panels and reusable editor primitives/style-list editors. Size alone is not sufficient justification.

## 6.2 Keep canonical API and domain definitions centralized

Use `@checklist/shared` for cross-boundary wire types, constants, and pure brewing math. Do not move React helpers, server repositories, error prose, environment access, or HTTP calls into the shared package. This makes the shared package a deliberate contract owner instead of a general dumping ground.

The large `packages/shared/src/index.ts` can be split into internal topic files later while retaining its package barrel, but only when a consolidation adds a clear topic boundary. A mechanical file-size split would create import churn without reducing complexity.

## 6.3 Add an explicit unused-code check after cleanup

Once the confirmed findings are resolved, add a repository `check:unused` command or CI step. Configure Knip with explicit entries for server CLIs/scripts, the web entry, Bruce's CommonJS main and registration conventions, Android convention files, and deployment scripts. Enable TypeScript unused-local/parameter diagnostics where practical, or run them as a dedicated check if test fixtures intentionally contain unused names.

This should be a guardrail, not an automated deletion list. Knip's Bruce/CommonJS and internally-used-export findings demonstrate why review remains necessary.

## 6.4 Avoid low-value abstractions

Leave the following separate unless future changes make their behavior converge:

- Mobile versus desktop keg cards (read-only/touch versus editable/desktop behavior).
- Local versus remote update triggers.
- Server device repository versus fallback facade.
- Bruce chat versus voice passage rendering where numbering and response context differ.
- Tiny `formatTime`, error-cleaning, and one-line mapping helpers whose semantics belong to their feature.
- LocalStorage settings versus server-backed color/default stores.

# 7. Obsolete / Legacy Code

| Location | Finding | Recommended action | Risk |
|---|---|---|---|
| `TODO.md` | Brew-session efficiency calculation is listed as unfinished, but `BrewSessionDetail.tsx` already calculates and displays it with optional override. | Remove the completed TODO. | Low |
| `TODO.md` | Electricity/water device support is listed as unfinished, but shared types, server ingestion, UI, and power/water agents are present. | Remove the completed items; retain only specific missing behavior if there is a verified gap. | Low |
| `TODO.md` | Dashboard/Settings line counts are stale and brittle. | Keep the architectural task but replace counts with named feature boundaries from section 6.1. | Low |
| `README.md` roadmap | “Audit trail” remains in the roadmap even though audit hook, history routes, and UI are implemented. | Update roadmap wording to the actual remaining audit work or remove the completed item. | Low |
| `apps/web/src/mockDevices.ts` | Superseded client-side mock implementation. | Remove as detailed in section 3. | Low |
| `apps/server/drizzle.config.{js,d.ts,js.map}` and tracked `__pycache__` | Generated development artifacts committed to source control. | Remove and prevent recurrence with ignore rules. | Low |
| Android example tests | Capacitor template code with stale package/application identifiers. | Remove; replace only with purposeful app tests. | Low |
| `BREW_DAY_SAMPLE_SECONDS` | Compatibility environment alias. | Retire only after the external deployment verification in section 4. | Medium |
| `deploy/brewplanner.env.example` | Active `ALERT_INTERVAL_SECONDS`, `CUSTOM_ALERT_INTERVAL_SECONDS`, and `BREW_SESSION_SAMPLE_SECONDS` knobs are not clearly documented; the legacy alias is not labeled. | Document active names, defaults, and the compatibility alias. Do not remove code based only on example-file absence. | Low |

No large blocks of commented-out implementation, old route tables, or dead feature flags were found. Brewer's Friend remains an active, configuration-driven integration and should not be removed. Migration history and compatibility-sensitive database structures are not cleanup targets.

# 8. Dependency Cleanup

Repository manifests, package scripts, imports/requires, config typing, tests, and deployment usage were traced. **No direct dependency is currently proven unused**, and Knip did not report an unused declared dependency or an unlisted dependency.

Recommended manifest cleanup:

- Move `@capacitor/cli` in `apps/web/package.json` from `dependencies` to `devDependencies`. It is used by development/build scripts and config tooling, not by the shipped web runtime. Keep `@capacitor/android`, `@capacitor/core`, and runtime plugins in dependencies.
- Do not remove `concurrently`, TypeScript, Zod, Vitest, Fastify/Drizzle/SQLite, audio/ONNX, or Capacitor packages; each has a traced script, build, runtime, or test consumer.
- There is no evidence of two direct libraries redundantly solving the same problem.

The lockfile contains deprecated **transitive** packages, including `@esbuild-kit/core-utils`/`esm-loader` through the current Drizzle Kit chain, `prebuild-install` through `better-sqlite3`, and `glob@11` through `@fastify/static`. Do not hand-delete them or remove their parent packages. In a separate dependency-upgrade change, update the direct parent packages to compatible releases, regenerate the lockfile, inspect migration/config release notes, rebuild the native SQLite dependency, and run the full validation matrix. Risk: **Medium to High** depending on the parent upgrade.

After removing the obsolete browser mock and generated files, rerun dependency analysis. No dependency appears to be used only by those files, so no removal is expected from that step.

# 9. Proposed Implementation Plan

## Phase 0: Establish a trustworthy baseline

### Step 0.1 — Stabilize the command long-poll test

- **Files affected:** `apps/server/src/commandPoll.test.ts`; possibly a test seam in `apps/server/src/devices/notify.ts`.
- **Exact change:** ensure the timeout-only test keeps a referenced handle or inject a timer strategy whose test instance remains referenced. Keep `timer.unref()` in production behavior. Do not simply delete the timeout assertion.
- **Why:** the current full run reports 216 server tests passed and four cancelled; the isolated suite reproduces cancellation at “gives up after the requested wait.” Cleanup needs a green baseline.
- **Dependencies:** none.
- **Risk:** Low if confined to test control; Medium if runtime timer code changes.
- **Verify:** run the targeted test repeatedly, then the full server suite; confirm the process still exits promptly with parked polls in a shutdown test.

### Step 0.2 — Record and protect the existing working tree

- **Files affected:** none.
- **Exact change:** capture the pre-cleanup `git status`/diff and work in small commits. Existing edits in `mock.ts`, Dashboard/chart/event-marker files, and their tests must not be overwritten.
- **Why:** several cleanup targets overlap user-owned changes.
- **Dependencies:** none.
- **Risk:** Low.
- **Verify:** compare each cleanup commit with the recorded baseline.

## Phase 1: Safe dead-code and artifact removal

### Step 1.1 — Remove generated and orphaned files

- **Files affected:** the Drizzle generated trio, seven tracked `.pyc` files, `shot.png`, `favicon-96.png`, icon-generation script, two Android template tests, and `.gitignore`.
- **Exact change:** delete only the files listed in section 3.1; stop generating `favicon-96.png`; add focused Python bytecode ignore rules.
- **Why:** these files have no build/runtime consumer and create noise or stale test signals.
- **Dependencies:** Step 0.2.
- **Risk:** Low.
- **Verify:** web production build, icon generation followed by clean `git status`, Drizzle config discovery/generation dry run, Python source syntax checks, and Android Gradle test/source compilation.

### Step 1.2 — Remove the superseded browser mock

- **Files affected:** `apps/web/src/mockDevices.ts`.
- **Exact change:** delete the file; do not modify the server mock/fallback path.
- **Why:** the server implementation is the active canonical mock and there are no client references.
- **Dependencies:** Step 0.2.
- **Risk:** Low.
- **Verify:** repository reference search, web type check, unit tests, production build, and manual mock-mode Devices/Settings checks.

### Step 1.3 — Remove unused imports, locals, and dead declarations

- **Files affected:** files in sections 3.2 and 3.3, excluding symbols scheduled for later consolidation.
- **Exact change:** remove eight unused imports/parameters/locals; delete confirmed dead runtime symbols and unused shared schema-derived aliases; remove only unused re-exports; privatize internally-used exports in small package-specific batches.
- **Why:** reduce dead surface without changing live implementations.
- **Dependencies:** Step 0.2 and external shared-package search for public aliases.
- **Risk:** Low.
- **Verify:** strict unused TypeScript pass, normal type check, Knip with reviewed entries, all tests, and web/server builds.

### Step 1.4 — Clean stale documentation

- **Files affected:** `TODO.md`, `README.md`, and `deploy/brewplanner.env.example`.
- **Exact change:** remove only demonstrably completed TODO/roadmap items; replace brittle line counts with feature boundaries; document active interval variables and label the legacy alias.
- **Why:** prevent completed work and undocumented active settings from misleading future cleanup.
- **Dependencies:** none, except external verification before deleting any cross-repo TODO.
- **Risk:** Low.
- **Verify:** compare every changed statement to live code/config and render Markdown.

## Phase 2: Low-risk canonical utilities

### Step 2.1 — Consolidate money formatting and Bruce PCM RMS

- **Files affected:** `PricePicker.tsx`, `money.ts`, Bruce engine/audio-echo files, and a Bruce audio utility/test.
- **Exact change:** replace exact copies with their canonical helper; preserve existing function inputs/outputs.
- **Why:** exact duplication with no domain divergence.
- **Dependencies:** Phase 1 only for a clean baseline.
- **Risk:** Low.
- **Verify:** formatter tests/UI snapshot and Bruce audio unit/full tests.

### Step 2.2 — Centralize route parsing

- **Files affected:** five server route modules plus new `routes/parse.ts` and tests.
- **Exact change:** introduce one typed Zod parser preserving the 400 payload; migrate one route group first, then the remaining groups; remove local helpers.
- **Why:** repeated validation/error plumbing.
- **Dependencies:** Step 1.3 removes the already-unused route import first.
- **Risk:** Low.
- **Verify:** route integration tests for valid, coerced/defaulted, and invalid body/query/param inputs; type check.

### Step 2.3 — Centralize mock identity and device-role logic

- **Files affected:** shared package, server mock, Devices, Settings, MetricChart, Dashboard, KioskDevice, KioskHome, and new pure web helper tests.
- **Exact change:** expose shared mock ID constant/helper; create the web device-role/grouping module; replace local functions one consumer at a time.
- **Why:** eliminate repeated magic numbers and classification rules.
- **Dependencies:** resolve pre-existing edits before changing `mock.ts` and Dashboard.
- **Risk:** Medium.
- **Verify:** table-driven classification tests for every device type/name, unchanged rendered grouping on desktop/kiosk, mock mode, type checks, and screenshots at supported breakpoints.

### Step 2.4 — Consolidate fermenter status polling

- **Files affected:** Dashboard, KioskHome, new hook and tests.
- **Exact change:** move API/history polling and semantic status derivation to one hook; preserve Dashboard cache and page-specific styling.
- **Why:** two independent implementations can drift in status thresholds and cadence.
- **Dependencies:** Step 2.3 establishes shared classification helpers.
- **Risk:** Medium.
- **Verify:** fake-timer tests for poll cadence and all states; remount/cache test; manual offline, active fermentation, completed fermentation, and kiosk checks.

### Step 2.5 — Introduce the server-backed store factory

- **Files affected:** `graphColors.ts`, `kegContentColors.ts`, `recipeDefaults.ts`, new store helper/tests.
- **Exact change:** capture shared hydrate/subscribe/save/reset mechanics in a generic helper while retaining current module APIs.
- **Why:** three copies of the same state machine.
- **Dependencies:** none beyond green client tests.
- **Risk:** Medium.
- **Verify:** contract tests run against all three configurations, including concurrent subscribers, first hydration, failed load, optimistic save, reset, and remount snapshots.

## Phase 3: Shared domain calculations and contracts

### Step 3.1 — Make shared brewing calculations canonical

- **Files affected:** shared package/tests, `apps/web/src/tools.ts` and its consumers/tests, `apps/server/src/bruce/tools.ts` and Bruce tool tests.
- **Exact change:** move pure dilution, gravity correction, carbonation pressure, and numeric guideline data to shared; retain boundary parsing/errors in web and Bruce wrappers.
- **Why:** duplicated scientific formulas are a correctness risk.
- **Dependencies:** Step 1.3 should settle shared exports first.
- **Risk:** Medium.
- **Verify:** golden-value tests at current rounding/edge cases, property checks where appropriate, Bruce conversational input tests, Water/Tools UI smoke tests, and full package tests.

### Step 3.2 — Consolidate ingredient conversions

- **Files affected:** `brewerfriend.ts`, `recipeData.ts`, new server conversion helper/tests.
- **Exact change:** share only normalized weight/count conversion; explicitly retain differing blank-unit validation and `other` ml/l handling at callers.
- **Why:** duplicate unit logic can silently diverge.
- **Dependencies:** none.
- **Risk:** Medium.
- **Verify:** fixture comparisons for kg/g/lb/oz/count/blank units, imported recipes, stored recipes, and miscellaneous volume ingredients.

### Step 3.3 — Centralize update response contracts and status reading

- **Files affected:** shared types, two server update modules, web API/update UI, tests.
- **Exact change:** define wire status types once; share status-file parsing/log tail; retain independent trigger and safety implementations.
- **Why:** eliminate cross-layer contract drift and duplicated mechanics without weakening rig safety.
- **Dependencies:** shared export cleanup in Step 1.3.
- **Risk:** Medium.
- **Verify:** compile-time type assertions, status fixture tests for missing/running/success/failed/stale/corrupt files, local handoff test, rig preflight test, and manual update UI polling.

## Phase 4: Security- and deployment-sensitive consolidation

### Step 4.1 — Extract Google service-account token handling

- **Files affected:** new server `googleAuth.ts`, Drive module, FCM push module, tests.
- **Exact change:** move credential parsing, JWT construction/signing, exchange, scope-aware cache, and expiry skew into one helper; retain integration-specific flows/errors.
- **Why:** security-sensitive duplication should have one tested implementation.
- **Dependencies:** green server tests and stable environment fixtures.
- **Risk:** High.
- **Verify:** mocked token exchange and clock tests, invalid-key tests, cache isolation by scope/credential, Drive backup/list smoke test, FCM dry run/test notification, and absence of secret/token logging.

### Step 4.2 — Extract sensor-agent runtime

- **Files affected:** `deploy/agents/common.py`, five agents, install/deployment files, tests or simulation harness.
- **Exact change:** move common scheduling/post/retry/shutdown lifecycle; keep hardware reads and command paths local; deploy the helper with every agent.
- **Why:** repeated reliability-critical logic currently requires five coordinated fixes.
- **Dependencies:** establish a repeatable simulate-mode/hardware validation harness first.
- **Risk:** High.
- **Verify:** Python syntax/unit tests, fake-clock retry/slot tests, simulated 200/error/timeout/server-interval responses for every agent, SIGTERM behavior, systemd startup, and staged testing on each hardware class.

## Phase 5: UI decomposition

### Step 5.1 — Decompose Dashboard by feature panel

- **Files affected:** Dashboard and new dashboard feature components/tests.
- **Exact change:** extract one state/API-isolated panel per commit after shared device/status logic is already removed; retain route ownership and DOM/CSS contracts.
- **Why:** improve change isolation in the largest page without inventing generic abstractions.
- **Dependencies:** Steps 2.3 and 2.4.
- **Risk:** Medium.
- **Verify:** component tests, API mocking, desktop/mobile/kiosk-adjacent responsive screenshots, timers/commands, charts, mock mode, and accessibility labels.

### Step 5.2 — Decompose Settings by settings domain

- **Files affected:** SettingsDesktop and new settings section/primitives/tests.
- **Exact change:** extract the named domains in section 6.1 one at a time; share markup primitives only where behavior is identical.
- **Why:** isolate independent settings APIs and reduce merge conflicts.
- **Dependencies:** Step 2.5 and resolution of existing working-tree edits.
- **Risk:** Medium.
- **Verify:** every save/reset/error path, permissions/admin-only sections, Bruce controls, update flows, keyboard/focus behavior, and responsive layout.

### Step 5.3 — Reassess Bruce and RecipeEditor

- **Files affected:** none initially; later only proven feature boundaries.
- **Exact change:** measure remaining coupling after earlier work. Extract only Chat/Voice/Knowledge or editor primitives with independent state/tests; otherwise document the decision to keep cohesive files.
- **Why:** avoid a speculative line-count refactor.
- **Dependencies:** prior phases.
- **Risk:** Medium.
- **Verify:** feature-level tests and unchanged route behavior for any extraction.

## Phase 6: Dependency and compatibility cleanup

### Step 6.1 — Reclassify Capacitor CLI

- **Files affected:** `apps/web/package.json`, root lockfile.
- **Exact change:** move `@capacitor/cli` to `devDependencies` without changing its version; regenerate the lockfile normally.
- **Why:** correctly describe build-time versus shipped-runtime ownership.
- **Dependencies:** none.
- **Risk:** Low.
- **Verify:** clean install in CI mode, web build, `cap sync`, and Android build.

### Step 6.2 — Retire verified compatibility artifacts

- **Files affected:** legacy sampler environment lookup, recipe backup tracking/ignore rules, verified Bruce export aliases, external TODO wording.
- **Exact change:** act only on candidates whose section 4 verification is complete; keep a written record for deferred candidates.
- **Why:** these cannot safely be decided from the repository alone.
- **Dependencies:** deployment/backup/external-repository evidence.
- **Risk:** Medium to High.
- **Verify:** deployment configuration audit, backup restore test, Bruce startup/tests, and at least one release overlap for renamed environment variables.

### Step 6.3 — Upgrade parents of deprecated transitive packages separately

- **Files affected:** relevant package manifests and lockfile.
- **Exact change:** update one direct parent family at a time; never edit transitive entries manually.
- **Why:** remove deprecated transitive code while making regressions attributable.
- **Dependencies:** all tests green; review upstream migration notes at implementation time.
- **Risk:** Medium to High.
- **Verify:** clean install, native module rebuild, Drizzle config/migration commands, server/web builds, all tests, and deployment smoke test.

## Phase 7: Final guardrails

### Step 7.1 — Add reviewed unused-code automation

- **Files affected:** root/package manifests, Knip config, TypeScript/CI config as appropriate.
- **Exact change:** add explicit entry points and a stable unused-code command; enable strict unused diagnostics after the known list is clean.
- **Why:** prevent regenerated files and dead exports from accumulating.
- **Dependencies:** Phases 1–6, because the current baseline intentionally fails strict unused checks.
- **Risk:** Low.
- **Verify:** the check passes from a clean clone and does not flag runtime-scanned data, Bruce registration, Android convention files, or deploy scripts.

# 10. Recommended Validation

At implementation time, validate each small change independently and run the complete matrix at phase boundaries:

1. **Static checks:** `npm run typecheck`; strict TypeScript unused-local/parameter checks; configured Knip; JavaScript syntax checks for Bruce; Python compile/AST checks; shell syntax checks for deployment scripts.
2. **Unit/integration tests:** all workspace tests, with special attention to command long polling, shared calculations, recipe import/storage conversions, update status, Google token caching, store hydration, event markers, and mock setpoints.
3. **Builds:** production web build, server build, Bruce startup/module registration, Capacitor sync, and Android Gradle build from a clean checkout.
4. **Server/API smoke tests:** login/session/bearer authentication, role/permission enforcement, invalid Zod inputs, SQLite reads/writes/migrations, device ingest/commands/acknowledgement, alerts, recipe backup/restore, Bruce routes, and music proxying.
5. **Responsive UI:** Dashboard, Devices, Kegs, Settings, Recipe Editor, Water Calculator, Bruce, kiosk home/device, and history/audit routes at desktop, mobile, and kiosk breakpoints. Compare screenshots where possible.
6. **Regression-sensitive behavior:** fermenter offline/completed transitions, cross-remount cache, chart ranges/markers, timers/stages, update polling/safety preflight, mock mode, reporting interval changes, and background/foreground Capacitor behavior.
7. **External integrations:** staged Drive backup, FCM test notification, Bruce Realtime startup/tool registration, rig update status, Brewer's Friend import, and music endpoints with optional credentials both present and absent.
8. **Hardware/deployment:** simulate all five agents before hardware rollout; then stage each hardware class, verify interval negotiation, buffered retry, setpoint commands, SIGTERM, systemd restart, logs, and offline recovery.
9. **Clean-repository check:** fresh dependency install, no generated tracked changes after build/icon/Drizzle/Python commands, and a reviewed `git diff --stat` for every cleanup commit.

Audit baseline on 2026-08-31:

- `npm run typecheck`: passes.
- Strict TypeScript unused diagnostics: eight confirmed findings listed in section 3.2.
- Shared tests: 30 passed.
- Bruce tests: 23 test groups passed.
- Web tests: 117 passed.
- Server tests: 216 passed and four cancelled; the cancellation is the pre-existing unreferenced-timer issue described in Phase 0.
- No direct unused dependency was found.
- No confirmed unused CSS selector was found in the five CSS modules or global class set; all selectors traced to code or deploy/main markup.

# 11. Cleanup Inventory

| Item | Location | Category | Proposed action | Confidence | Risk |
|---|---|---|---|---|---|
| Legacy browser mock | `apps/web/src/mockDevices.ts` | Remove | Delete superseded file | High | Low |
| Generated Drizzle outputs | `apps/server/drizzle.config.{js,d.ts,js.map}` | Remove | Keep TS source only | High | Low |
| Python bytecode caches | web script and five deploy-agent trees | Remove | Delete and add ignore rules | High | Low |
| Root screenshot | `shot.png` | Remove | Delete orphan asset | High | Low |
| Unreferenced favicon | `apps/web/public/favicon-96.png` | Remove | Delete and stop generating | High | Low |
| Capacitor template tests | Android unit/instrumented test paths | Remove | Delete stale examples | High | Low |
| Eight unused imports/locals | Server/web paths in §3.2 | Remove | Delete bindings/parameter | High | Low |
| Four unused shared constants | `packages/shared/src/index.ts` | Remove | Delete declarations | High | Low |
| Unused schema-derived aliases | `packages/shared/src/index.ts` | Remove | Delete aliases, retain schemas | High in repo | Low |
| Dead web/server symbols | Paths in §3.3 | Remove | Delete symbols or unused re-exports | High | Low |
| Internally used public exports | Server/web modules in §3.3 | Simplify | Remove export modifiers only | High in repo | Low |
| Device role/group helpers | Five web consumers | Consolidate | Canonical pure web module | High | Medium |
| Ferment status polling | Dashboard and KioskHome | Consolidate | Canonical hook, preserve styling/cache | High | Medium |
| Brewing formulas | web tools and Bruce server tools | Merge | Canonical shared pure calculations | High | Medium |
| Server-backed stores | graph, keg colors, recipe defaults | Consolidate | Generic store factory plus facades | High | Medium |
| Route Zod parse helpers | five server route modules | Consolidate | One typed parser/error helper | High | Low |
| Google service auth | Drive and FCM modules | Consolidate | Shared scoped token helper | High | High |
| Sensor runtime | five Python agents | Consolidate | Shared lifecycle, local hardware reads | High | High |
| Update status/contracts | two server modules and web API | Consolidate | Shared wire types and status reader only | High | Medium |
| Mock ID `900000` | shared/server/two web pages | Consolidate | Shared constant/helper | High | Low |
| `kr` formatter | PricePicker and `money.ts` | Merge | Use existing money utility | High | Low |
| Ingredient conversions | Brewer's Friend and recipe data | Consolidate | Shared server weight/count core | Medium | Medium |
| PCM RMS | two Bruce audio modules | Merge | One pure utility | High | Low |
| Password icons | Login and Settings | Merge | Use existing icon module if equivalent | Medium | Low |
| Dashboard feature panels | `Dashboard.tsx` | Simplify | Extract stable domain panels after hooks | High | Medium |
| Settings domains | `SettingsDesktop.tsx` | Simplify | Extract stable settings sections | High | Medium |
| Shared monolith | `packages/shared/src/index.ts` | Needs verification | Split only along real new topic boundaries | Medium | Medium |
| Recipe backup snapshots | `apps/server/data/recipe-backups/` | Needs verification | Confirm external recovery copies, then untrack/ignore | Medium | High |
| Legacy sample env alias | server sampler/deploy env | Needs verification | Audit every deployment before removal | High suspicion | Medium |
| Bruce CJS aliases | `apps/bruce/src/` | Needs verification | Search external scripts before removal | Medium | Medium |
| Completed/stale TODOs | `TODO.md`, `README.md` | Remove | Update to current state | High | Low |
| Missing env documentation | `deploy/brewplanner.env.example` | Simplify | Document active interval settings | High | Low |
| Capacitor CLI classification | `apps/web/package.json` | Dependency cleanup | Move to devDependencies | High | Low |
| Deprecated transitive packages | lockfile via Drizzle/SQLite/Fastify parents | Dependency cleanup | Upgrade direct parents separately | High | Medium–High |
| Unused-code guardrail | root/CI config | Consolidate | Add reviewed Knip/strict-unused check | High | Low |
| Migrations, Android variants, icons, models, knowledge, prices | repository-wide | Keep | Preserve intentional indirect/convention usage | High | High if removed |
