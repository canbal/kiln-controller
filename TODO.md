# Modern UI Migration Plan (Kiln Controller)

Owner: solo maintainer (primary user)
Status: active plan (implementation staged via small additive PRs)
Last updated: 2026-02-08

This document is the source of truth for the UI modernization work.
If the plan changes, update this file first, then implement.

## Goals

- Modern, mobile-first UI that works well on phones and small screens.
- Keep existing Python kiln logic working; do not destabilize firing behavior.
- Keep the existing `/picoreflow` UI fully usable throughout migration.
- Make it easy for AI agents to implement features end-to-end without needing maintainer guidance.
- Early win: add read-only views and better charts (including natural cooling tail beyond profile end).
- Later: firing history + notes, config control panel, and eventually improved profile editing.

## Non-Goals

- Rewrite PID / thermocouple / oven simulation logic.
- Big-bang rewrite of server + UI.
- Replace Bottle/gevent-websocket during the UI migration.
- Add authentication (assume trusted LAN for now).

## Hard Constraints (Operational + Safety)

- The kiln controller is actively used. The repo can be pulled onto the kiln and restarted at any time.
- Old UI remains functional until explicit decommission.
- All changes are additive until old UI deprecation is explicitly scheduled.
- No breaking changes to existing endpoints and message shapes.
- Every PR must have a rollback story: old UI continues to operate the kiln.

## Locked Decisions (No Open Questions)

- Security posture: trusted LAN, no auth.
- Backend: keep Bottle/gevent-websocket. Only additive REST endpoints under `/v1/*`.
- Deployment: keep the existing workflow (pull `master` on kiln + restart uses that code).
- New UI is complementary and read-only first. Old UI remains the editing surface until later milestones.
- Session storage: SQLite (single local DB file).
- Sampling cadence: one sample per control loop cycle (`config.sensor_time_wait`, currently 1 second).
- Sample payload: store the full `Oven.get_state()` payload per sample as JSON (no early optimization).
- Cooling capture default stop condition:
  - Stop when temperature drops below 200F (or 93C if `config.temp_scale == "c"`).
  - Safety backstop: stop after 48 hours even if threshold is not reached.

## Current System Surface (Compatibility Target)

From `kiln-controller.py` (as of 2026-02-08):

- `/` redirects to `/picoreflow/index.html`.
- `/picoreflow/:filename#.*#` serves static files from `public/`.
- WebSocket:
  - `/control` receives JSON commands like `{ "cmd": "RUN", "profile": <profile_obj> }` and `{ "cmd": "STOP" }`.
  - `/status` streams state updates via `OvenWatcher`.
  - `/storage` supports profile GET/PUT/DELETE.
  - `/config` returns a small subset of config values.
- REST:
  - `POST /api` supports `{cmd: run|stop|memo|stats}` (see `docs/api.md`).
  - `GET /api/stats` returns PID stats when available.

Migration rule: the above must keep working unchanged until old UI is explicitly deprecated.

## Design Principles (Agent-Friendly)

- Contract-first: document payload shapes and units before building UI features.
- Validate inputs at boundaries:
  - Frontend parses WS/REST payloads with runtime validation (Zod).
  - Backend validates new endpoint inputs.
- Prefer popular, documented libraries; avoid custom UI primitives.
- Keep PRs small and vertical (one capability at a time), with explicit acceptance criteria.

## Target Tech Stack

Frontend (new UI):

- React + TypeScript + Vite.
- Component library: Mantine (preferred) or MUI. Pick one and standardize.
- Data fetching/state: TanStack Query.
- Runtime validation: Zod.
- Charts: Apache ECharts (time series + zoom/pan + annotations).
- Testing: Vitest (unit) + Playwright (e2e, include a mobile viewport run).

Backend (during migration):

- Keep Bottle/gevent-websocket.
- Add SQLite for sessions history.
- Add new REST endpoints under `/v1/*` for additive features.

## Data Model (SQLite)

Purpose: record firing sessions and enable cooling-tail and history views.

Tables (initial, simplest):

- `sessions`
  - `id` TEXT PRIMARY KEY (uuid)
  - `created_at` INTEGER (unix seconds)
  - `started_at` INTEGER NULL
  - `ended_at` INTEGER NULL
  - `profile_name` TEXT NULL
  - `outcome` TEXT NULL (e.g. RUNNING, COMPLETED, ABORTED, ERROR)
  - `notes` TEXT NULL
  - `meta_json` TEXT NULL (optional, future-proof)

- `session_samples`
  - `session_id` TEXT (FK-ish)
  - `t` INTEGER (unix seconds)
  - `state_json` TEXT (full JSON of `Oven.get_state()` plus any additive fields)

Indexes:

- `session_samples(session_id, t)`
- `sessions(created_at)`

Notes:

- Keep migrations minimal. Store a schema version in a table (e.g. `schema_version`).
- Do not store secrets.

## New Backend API (Additive)

New endpoints are additive and versioned. Do not remove or change old ones.

Proposed minimal endpoints (names can change, but keep them versioned and documented):

- `POST /v1/sessions/start`
  - Creates a session, returns `{id}`.
  - Can be invoked from server when a run starts (preferred) and/or from UI.
- `POST /v1/sessions/:id/stop`
  - Marks session ended with outcome.
- `GET /v1/sessions`
  - Lists sessions (newest first).
- `GET /v1/sessions/:id`
  - Session metadata + computed summary.
- `GET /v1/sessions/:id/samples?from=&to=`
  - Returns samples in a time window.
- `PATCH /v1/sessions/:id`
  - Update notes.

Config panel endpoints (later milestone):

- `GET /v1/config` (effective config subset)
- `PUT /v1/config/overrides` (write `config_override.json`)
- `POST /v1/config/apply` (explicit apply semantics; apply only when not RUNNING)

## Contracts (Docs Required)

Before implementing UI features, create/update a contract doc that includes:

- WS `/status` message types actually emitted in practice.
- The `Oven.get_state()` shape and units.
- Any new `/v1/*` request/response payloads.

Deliverables:

- `docs/contracts.md` with example JSON payloads.
- Optional: `docs/fixtures/` containing saved JSON fixtures for UI parsing tests.

## Milestones / PR Plan (Sequenced for Early Value)

Each milestone should be deliverable as 1-3 small PRs.
Do not implement later milestones until earlier ones are stable on the kiln.

### 0) Docs Only: Contracts + Fixtures

Work:

- Add/maintain `docs/contracts.md`.
- Capture example `/status` backlog message and steady-state messages.
- Capture `/api/stats` payload example.

Acceptance:

- Another agent can implement a typed API client and chart without asking questions.

### 1) New UI Shell (Complementary, Read-Only, Side-by-Side)

Work:

- Add a new route (recommended `/app`) serving a new frontend.
- Keep `/` redirect and `/picoreflow` intact.
- Basic responsive layout with:
  - connection status
  - current temperature, target temperature, run state
  - error/banner area

Acceptance:

- `/picoreflow` unchanged.
- `/app` loads on desktop and phone.

### 2) Read-Only Dashboard + Live Chart (Immediate UX Improvement)

Work:

- Implement a robust live chart (actual temp + target when available).
- Add clear metrics cards (mobile-first).
- Add graceful WS reconnect behavior.

Acceptance:

- Works reliably on small screens.
- No profile editing features in new UI yet.

### 3) Sessions Capture (SQLite) + Cooling Tail Recording (Foundational)

Work:

- Add SQLite DB and minimal migration/versioning.
- Create a session for each run and store samples at 1Hz.
- Store full state per sample as JSON.
- Continue recording after profile ends until stop condition:
  - temp < 200F/93C OR 48h cap.

Acceptance:

- A test run produces a session and sample rows.
- Recording includes post-profile cooling tail.

### 4) Cooling Tail Visualization (Pulled Early)

Work:

- UI can view the current session or most recent session.
- Chart shows:
  - actual temperature line
  - target line while RUNNING (optional, depends on stored state)
  - marker for end-of-profile and end-of-cooling-capture
- Ensure long sessions render without freezing (windowed queries or basic downsampling on display only).

Acceptance:

- Natural cooling tail is visible and reviewable.

### 5) Minimal Controls in New UI (Optional Convenience)

Work:

- Profile selection + start/stop via existing `/api` or `/control`.
- Strong safety UX: clear state, confirmations, and error handling.
- Old UI remains the fallback.

Acceptance:

- New UI can start/stop a run, but does not block continued use of old UI.

### 6) Firing History + Notes (User Value + Platform)

Work:

- UI: sessions list + session detail page + notes.
- Backend: `/v1/sessions/*` endpoints implemented.

Acceptance:

- Past firings are browseable; notes persist.

### 7) Config Control Panel (Safe, Additive)

Work:

- Introduce `config_override.json` (do not write to `config.py`).
- Apply semantics: only when kiln is NOT running (RUNNING must block apply).
- UI groups settings with ranges and warnings.

Acceptance:

- Config changes can be made without editing `config.py`, safely.

### 8) Profile Editor V1 (Later)

Work:

- CRUD and table-first editor.
- Strong validation (monotonic time, sane slopes, unit conversions).

Acceptance:

- Editing is safer and less clunky than old UI.

### 9) Profile Editor V2 + Live Profile Editing During Run (Later, Major Feature)

Work:

- Drag/graph editing and/or live edits of future schedule points.
- Rules for live edits (V1):
  - cannot change the past
  - edits must be future-only relative to current runtime
  - server validates monotonic time and basic slope constraints
- Every live edit is recorded as a session event (append-only audit trail).

Acceptance:

- Live edits change the remaining target curve safely and are auditable.

### 10) Decommission Old UI

Work:

- Only after new UI is stable and provides required operational capability.
- Switch `/` from `/picoreflow` to `/app` and keep a temporary fallback link.

Acceptance:

- New UI is default; old UI removed only when safe.

## Testing Strategy (Minimum Bar)

Backend:

- Add tests for SQLite session creation + sample capture + stop rules.
- Run in simulation mode for automated tests.

Frontend:

- Unit tests for payload parsing (Zod) using fixtures.
- Playwright smoke tests:
  - `/app` loads in a mobile viewport
  - WS reconnect works
  - session appears after a simulated run
  - cooling tail visible

Operational:

- Every PR must keep `/picoreflow` functional.

## How to Use This Plan

- Treat milestones as gates. Do not start editing features until read-only + sessions + cooling are stable.
- Prefer small PRs with clear acceptance criteria.
- If a tradeoff arises, prioritize kiln safety and operational stability over UI polish.
