# Modern UI Migration Plan (Kiln Controller)

Owner: solo maintainer (primary user)
Status: active plan (implementation staged via small additive PRs)
Last updated: 2026-02-08

This document is the source of truth for the UI modernization work.
If the plan changes, update this file first, then implement.

## Collaboration Workflow (Multi-Agent)

This repo is expected to have multiple AI agents contributing over time.
To keep work parallelizable and reviewable, follow these conventions:

- One agent should work on exactly one Task ID.
- One PR should implement one Task ID.
- Always work on a branch and use PRs; do not push directly to the default branch (`master`/`main`).
- Every PR must be reviewed by the human maintainer before it is merged.
  - Agents must not merge PRs on their own.
  - Wait for an explicit maintainer message containing the word "merge" for that PR before merging.
  - Exception: bookkeeping-only PRs that *only* update `TODO.md` task status/checkboxes/PR links/merge SHAs may be merged without human review.
- Update `TODO.md` as part of the PR lifecycle:
  - when you open a PR for a task, mark it `IN_PROGRESS`, set `owner:`, and fill `PR:`
  - when the PR is merged, mark it `DONE` and fill `commit:` with the merge SHA
  - when a task is `DONE`, also check its box (`- [x]`)
- Handoff expectation: after completing a task (typically after the bookkeeping PR merges), include a copy/paste prompt for the next agent.
- The maintainer will often clear chat context and start a new session; the handoff prompt should be self-contained and point to the next Task ID.
- Also copy the handoff prompt to the clipboard on macOS by executing `pbcopy` in the repo shell (so the maintainer only needs to paste into the new chat).

### End-of-Session Handoff (Required)

At the end of *every* task session (feature PR merged + bookkeeping PR merged), the agent must end the chat with a paste-able handoff instruction for the next agent.

Rules:

- The final assistant message must include a section titled `Next Agent Handoff` containing a single fenced code block that can be copy/pasted into a new chat.
- The handoff prompt must be self-contained (assume the next agent has zero context).
- The handoff prompt must include:
  - which Task ID to pick next (or "stop" if no next task)
  - what branch/PRs were created/merged in the just-finished task
  - the merge SHA(s)
  - any follow-ups, caveats, or local verification steps
- On macOS, copy the handoff prompt to the clipboard by running:
  - `pbcopy < /tmp/next-agent-handoff.txt` (preferred), OR
  - `printf '%s' "..." | pbcopy` (avoid if long)

Suggested workflow for clipboard:

1) Write the handoff text to `/tmp/next-agent-handoff.txt` (using a heredoc in the repo shell).
2) Run `pbcopy < /tmp/next-agent-handoff.txt`.
3) Paste the same content in the final assistant message.
- Every PR that changes behavior should update this `TODO.md`:
  - mark the relevant Task ID(s) as DONE
  - add the merge commit SHA(s)
  - link the PR number/URL if available
- Prefer parallel work by splitting across Workstreams (frontend shell, backend sessions, docs, etc.).
- Avoid breaking changes and avoid touching `/picoreflow` during migration.

### Local Development (macOS)

Goal: run the server locally without Pi hardware.

1) Create and activate a virtualenv, install deps:

```bash
python3 -m venv kilnenv
source kilnenv/bin/activate
pip install -r requirements-local.txt
```

If you need Pi hardware deps on an actual Raspberry Pi, use `pip install -r requirements.txt`.

If local installs still fail on macOS, use the Docker path below instead.

2) For local mac dev, do not edit `config.py`. Use env vars:

- `DEVELOPMENT=1` forces `simulate=True`
- `PORT=8080` avoids needing sudo for port 80

3) Run the server:

```bash
source kilnenv/bin/activate && PORT=8080 DEVELOPMENT=1 ./kiln-controller.py
```

4) Open:

- `http://localhost:8080/` (redirects to legacy UI)
- `http://localhost:8080/picoreflow/index.html` (legacy UI direct)
- `http://localhost:8080/app`

Notes:

- If you keep `listening_port = 80`, you will likely need `sudo` on macOS.
- Before deploying to the kiln, ensure `config.py` is set back to your Pi settings.

#### macOS + Docker (More Reliable)

This runs the server in a Linux container, which tends to avoid macOS build issues.

```bash
docker run --rm -it \
  -p 8080:8080 \
  -v "$PWD":/work \
  -w /work \
  python:3.11-slim bash
```

Inside the container:

```bash
python -m venv kilnenv
source kilnenv/bin/activate
pip install -r requirements.txt
```

Then do the same `config.py` local tweaks (`simulate = True`, `listening_port = 8080`) and run:

```bash
./kiln-controller.py
```

### Visual Validation Checklist (Human-Reviewed PRs)

Some PRs (especially UI) require a human to visually validate behavior.

Rules:

- Every PR that changes UI or routing must include a PR description checklist using GitHub task list items.
- The maintainer should check these boxes before merging.
- Agents should run automated/non-visual validations when possible (lint, unit tests, curl smoke checks), but still ask the maintainer to re-validate visuals.

Suggested PR checklist template:

```md
## Visual Validation (maintainer)
- [ ] `/picoreflow/index.html` loads and is functional
- [ ] `/app` loads on a phone-sized viewport (or device)
- [ ] No unexpected console errors / server tracebacks
```

### Status Legend

- PLANNED: not started
- IN_PROGRESS: actively being worked on (include owner/agent handle)
- BLOCKED: needs a dependency task completed
- DONE: merged to `master` (include merge commit SHA)
- DEFERRED: intentionally postponed

### Task Record Format

Each task uses a stable ID, so multiple agents can coordinate without confusion.

Use this template when adding new tasks:

- [ ] `T-XXXX` Short title
  - status: PLANNED | IN_PROGRESS | BLOCKED | DONE | DEFERRED
  - owner: @handle-or-agent-name
  - deps: `T-YYYY`, `T-ZZZZ`
  - acceptance: one sentence of how to verify
  - PR: <url or number>
  - commit: <merge sha>

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

## Workstreams (For Parallel Execution)

Agents can work in parallel as long as dependencies are respected:

- WS-DOCS: contracts, fixtures, API docs
- WS-FE-SHELL: new UI shell, layout, routing, mobile-first structure
- WS-FE-CHARTS: charting, WS client, cooling-tail visualization
- WS-BE-SESSIONS: SQLite DB, session lifecycle, sampling, cooling capture
- WS-FE-CONTROLS: minimal start/stop and profile selection (optional early)
- WS-FE-HISTORY: session list/detail, notes UI
- WS-BE-API: `/v1/*` endpoints for sessions/config
- WS-CONFIG: config override storage + UI (later)
- WS-PROFILES: profile editor (later)
- WS-LIVE-EDIT: live profile edits during run (later)

## Task Board (Source of Truth)

Rules:

- Only mark DONE when merged to `master`.
- Always fill in `commit:` for DONE tasks.
- When a task is DONE, its checkbox must be checked (`- [x]`).
- Keep tasks small enough for review (ideally < ~500 LOC net change per PR).

### Milestone 0: Docs Only (Contracts + Fixtures)

- [x] `T-0001` Add `docs/contracts.md` covering `/status`, `/control`, `/storage`, `/config`, `/api`
  - status: DONE
  - owner: @opencode
  - deps:
  - acceptance: `docs/contracts.md` includes example JSON payloads and units
  - PR: https://github.com/canbal/kiln-controller/pull/1
  - commit: a2126dd94ea50cf10c67f8036c66dbfc4575d6aa

- [x] `T-0002` Add fixture JSON for `/status` backlog + steady-state messages
  - status: DONE
  - owner: @opencode
  - deps: `T-0001`
  - acceptance: fixtures exist and are referenced by docs/tests later
  - PR: https://github.com/canbal/kiln-controller/pull/5
  - commit: b4996e65319d81436cbfcd5f7d5ebc967b918d01

- [x] `T-0003` Add fixture JSON for `/api/stats` payload
  - status: DONE
  - owner: @opencode
  - deps: `T-0001`
  - acceptance: fixture exists and matches current server output shape
  - PR: https://github.com/canbal/kiln-controller/pull/7
  - commit: 86664e71c7cf3680592880fa24fe190d3f8b9f6f

### Milestone 1: New UI Shell (Complementary, Read-Only)

- [x] `T-0101` Add `/app` route that serves new static UI without touching `/picoreflow`
  - status: DONE
  - owner: @opencode
  - deps: `T-0001`
  - acceptance: `/picoreflow/index.html` still loads; `/app` loads on phone
  - PR: https://github.com/canbal/kiln-controller/pull/10
  - commit: 01ff6267bb41e54a50dabeb9887334e64048d9c8

- [x] `T-0102` Create `frontend/` React+TS+Vite skeleton and produce committed build output in `public/app/`
  - status: DONE
  - owner: @opencode
  - deps: `T-0101`
  - acceptance: repo can be pulled on kiln and restarted without extra build steps
  - PR: https://github.com/canbal/kiln-controller/pull/12
  - commit: a2a041d4d921c4e8400b8ccbd9f0402af839379f

### Milestone 2: Read-Only Dashboard + Live Chart

- [x] `T-0201` Implement WS `/status` client with reconnect and Zod validation
  - status: DONE
  - owner: @opencode
  - deps: `T-0002`, `T-0102`
  - acceptance: UI survives WS disconnect/reconnect and continues updating
  - PR: https://github.com/canbal/kiln-controller/pull/16
  - commit: 507073b348796a89ec06b8a3a53f5b3f0e7e1035

- [x] `T-0202` Add read-only dashboard metrics (temp/target/state) optimized for small screens
  - status: DONE
  - owner: @opencode
  - deps: `T-0201`
  - acceptance: phone layout is usable without horizontal scrolling
  - PR: https://github.com/canbal/kiln-controller/pull/18
  - commit: e010fc5347b76b4d10afe5106371e74251118bd8

- [x] `T-0203` Add ECharts live plot (actual temp + target when available)
  - status: DONE
  - owner: @opencode
  - deps: `T-0201`
  - acceptance: chart renders and updates without noticeable lag
  - PR: https://github.com/canbal/kiln-controller/pull/21
  - commit: 0ea35cd49b7299a063228a029af0944589143bc0

- [x] `T-0204` Live chart: start zoomed out until 30m, then lock window + pan
  - status: DONE
  - owner: @opencode
  - deps: `T-0203`
  - acceptance: before 30 minutes, chart stays fully zoomed out; after 30 minutes, it pans a fixed 30-minute window unless the user manually zooms/pans
  - PR: https://github.com/canbal/kiln-controller/pull/28
  - commit: ae2ac95a29f440dc6e08571c20da66059e43087d

### Milestone 3: Sessions Capture + Cooling Tail Recording (SQLite)

- [x] `T-0301` Add SQLite DB file, schema versioning, and minimal migrations
  - status: DONE
  - owner: @opencode
  - deps:
  - acceptance: fresh boot creates DB; version table exists
  - PR: https://github.com/canbal/kiln-controller/pull/23
  - commit: 3055636d96cc641ce14de0bd9a9098f4b4cf379f

- [x] `T-0302` Create/stop sessions automatically on run start/stop (server-driven)
  - status: DONE
  - owner: @opencode
  - deps: `T-0301`
  - acceptance: starting a run creates a session row with profile_name
  - PR: https://github.com/canbal/kiln-controller/pull/25
  - commit: 3b85d4480caef487a22c09ad3431e78b27dac706

- [x] `T-0303` Persist one sample per control loop (`sensor_time_wait`) with full `Oven.get_state()` JSON
  - status: DONE
  - owner: @opencode
  - deps: `T-0302`
  - acceptance: 10-minute run produces ~600 samples
  - PR: https://github.com/canbal/kiln-controller/pull/27
  - commit: 1cbff47b4d75628db7e19f1f53ecb16b1bcde302

- [ ] `T-0304` Continue recording after profile end until temp threshold/cap reached
  - status: IN_PROGRESS
  - owner: @opencode
  - deps: `T-0303`
  - acceptance: post-profile cooling samples exist and stop at <200F/93C (or 48h)
  - PR:
  - commit:

### Milestone 4: Cooling Tail Visualization (Early Feature)

- [ ] `T-0401` Add `/v1/sessions` and `/v1/sessions/:id/samples` read endpoints
  - status: PLANNED
  - owner:
  - deps: `T-0304`
  - acceptance: curl can list sessions and fetch a sample window
  - PR:
  - commit:

- [ ] `T-0402` New UI: show most recent session chart with cooling tail + markers
  - status: PLANNED
  - owner:
  - deps: `T-0401`, `T-0203`
  - acceptance: chart shows tail beyond end-of-profile and indicates end marker
  - PR:
  - commit:

### Milestone 5: Minimal Controls in New UI (Optional)

- [ ] `T-0501` New UI: profile selection (read-only list) using existing `/storage` or new endpoint
  - status: PLANNED
  - owner:
  - deps: `T-0102`
  - acceptance: profile list shows and selection persists in UI state
  - PR:
  - commit:

- [ ] `T-0502` New UI: start/stop run using existing `/api` (add safety confirmations)
  - status: PLANNED
  - owner:
  - deps: `T-0501`
  - acceptance: run starts/stops reliably; old UI still works
  - PR:
  - commit:

### Milestone 6: Firing History + Notes

- [ ] `T-0601` Add `/v1/sessions/:id` and `PATCH /v1/sessions/:id` for notes
  - status: PLANNED
  - owner:
  - deps: `T-0401`
  - acceptance: notes persist across restarts
  - PR:
  - commit:

- [ ] `T-0602` New UI: session list + detail page + notes editing
  - status: PLANNED
  - owner:
  - deps: `T-0601`
  - acceptance: user can browse and annotate past firings on phone
  - PR:
  - commit:

### Milestones 7-10: Later Work (Config, Profile Editing, Decommission)

- [ ] `T-0701` Config override file (`config_override.json`) + safe apply semantics (block when RUNNING)
  - status: PLANNED
  - owner:
  - deps:
  - acceptance: overrides apply only when kiln not running
  - PR:
  - commit:

- [ ] `T-0801` Profile editor V1 (table-first) in new UI
  - status: PLANNED
  - owner:
  - deps:
  - acceptance: can edit/save profiles without using old UI
  - PR:
  - commit:

- [ ] `T-0901` Live profile editing during run (future-only) + audit trail stored with session
  - status: PLANNED
  - owner:
  - deps: `T-0602`
  - acceptance: live edits affect future target curve and are recorded
  - PR:
  - commit:

- [ ] `T-1001` Decommission old UI (switch `/` to `/app`, keep fallback temporarily)
  - status: PLANNED
  - owner:
  - deps: `T-0801`
  - acceptance: new UI is default; old UI retired safely
  - PR:
  - commit:

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

## Change Log

- 2026-02-08: initial plan added (commit `e223b48`)
- 2026-02-09: local dev logging uses Rich when `DEVELOPMENT=1`
