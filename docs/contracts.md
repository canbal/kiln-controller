# Contracts (Legacy API + WebSockets)

This document describes the payloads emitted/accepted by the current kiln controller
server as implemented in `kiln-controller.py`, `lib/oven.py`, and `lib/ovenWatcher.py`.

Migration constraint: these endpoints and message shapes must remain compatible while
the new UI is rolled out.

Unless otherwise noted:

- Temperature units follow `config.temp_scale` (`"f"` or `"c"`).
- Time values are seconds (Unix timestamps are explicitly called out).
- JSON examples are representative; optional fields may be missing depending on
  state and runtime conditions.

## WebSocket: `/status`

Purpose: stream live kiln state once per control loop (`config.sensor_time_wait`).

Client connection:

- URL: `ws(s)://<host>:<port>/status`
- The server pushes data without requiring a client subscription message.

### Message: backlog envelope (sent once on connect)

When a client connects, `OvenWatcher.add_observer()` immediately sends a backlog
message containing the most recent RUNNING samples (downsampled) and the last
run profile (if available).

Example:

Fixture: `docs/fixtures/status_backlog.json`

```json
{
  "type": "backlog",
  "profile": {
    "type": "profile",
    "name": "cone-05-long-bisque",
    "data": [[0, 65], [600, 200], [7500, 250]]
  },
  "log": [
    {
      "cost": 0.02,
      "runtime": 12.0,
      "temperature": 72.4,
      "target": 65.0,
      "state": "RUNNING",
      "heat": 1.0,
      "totaltime": 54600,
      "kwh_rate": 0.42818,
      "currency_type": "$",
      "profile": "cone-05-long-bisque",
      "pidstats": {
        "time": 1739052274.0,
        "timeDelta": 1.0,
        "setpoint": 65.0,
        "ispoint": 72.4,
        "err": -7.4,
        "errDelta": -1.2,
        "p": -370.0,
        "i": 0.0,
        "d": -600.0,
        "kp": 50,
        "ki": 30,
        "kd": 500,
        "pid": -100,
        "out": 0.0
      }
    }
  ]
}
```

Notes:

- `profile` may be `null` if no run has been started since boot.
- `log` may be empty.
- `pidstats` can be an empty object early in a run (before the first PID compute).

### Message: live oven state (sent repeatedly)

After connect, the watcher thread broadcasts `Oven.get_state()` once per control
loop. This message is *not* wrapped; it is a plain JSON object.

Example:

Fixtures:

- `docs/fixtures/status_state_running.json`
- `docs/fixtures/status_state_idle.json`

```json
{
  "cost": 1.73,
  "runtime": 3600.0,
  "temperature": 942.1,
  "target": 950.0,
  "state": "RUNNING",
  "heat": 1.0,
  "totaltime": 54600,
  "kwh_rate": 0.42818,
  "currency_type": "$",
  "profile": "cone-05-long-bisque",
  "pidstats": {
    "time": 1739055874.0,
    "timeDelta": 1.0,
    "setpoint": 950.0,
    "ispoint": 942.1,
    "err": 7.9,
    "errDelta": 0.4,
    "p": 395.0,
    "i": 120.3,
    "d": 200.0,
    "kp": 50,
    "ki": 30,
    "kd": 500,
    "pid": 100,
    "out": 1.0
  }
}
```

Field notes (current implementation):

- `state`: `"IDLE"` or `"RUNNING"`.
- `runtime`: seconds elapsed since run start (float).
- `totaltime`: profile duration in seconds.
- `heat`:
  - real oven: `1.0` when heating, `0.0` when not
  - simulated oven: seconds heater was on during the last control window
- `profile`: profile name string when running; `null` when idle.

## WebSocket: `/control`

Purpose: start/stop runs.

- URL: `ws(s)://<host>:<port>/control`

The server expects JSON messages.

### Command: RUN

Example:

```json
{
  "cmd": "RUN",
  "profile": {
    "type": "profile",
    "name": "cone-05-long-bisque",
    "data": [[0, 65], [600, 200], [7500, 250]]
  }
}
```

Notes:

- `profile` is required for a clean start; the server does not validate the
  profile shape beyond attempting to construct a `Profile`.

### Command: STOP

Example:

```json
{ "cmd": "STOP" }
```

## WebSocket: `/storage`

Purpose: profile CRUD.

- URL: `ws(s)://<host>:<port>/storage`

### Command: GET (string, not JSON)

Client sends:

```text
GET
```

Server responds with a JSON array of profiles:

```json
[
  { "type": "profile", "name": "cone-05-long-bisque", "data": [[0, 65], [600, 200]] },
  { "type": "profile", "name": "cone-6-long-glaze", "data": [[0, 65], [3600, 250]] }
]
```

### Command: PUT

Client sends:

```json
{
  "cmd": "PUT",
  "profile": { "type": "profile", "name": "my-profile", "data": [[0, 70], [600, 200]] }
}
```

Server responds with an ack message and then (currently) sends the updated
profile list:

```json
{ "cmd": "PUT", "profile": { "type": "profile", "name": "my-profile", "data": [[0, 70], [600, 200]] }, "resp": "OK" }
```

### Command: DELETE

Client sends:

```json
{
  "cmd": "DELETE",
  "profile": { "type": "profile", "name": "my-profile", "data": "" }
}
```

Server responds with an ack message:

```json
{ "cmd": "DELETE", "profile": { "type": "profile", "name": "my-profile", "data": "" }, "resp": "OK" }
```

## WebSocket: `/config`

Purpose: read a small subset of configuration.

- URL: `ws(s)://<host>:<port>/config`
- Client can send any message; server responds with the config JSON each time.

Example response:

```json
{
  "temp_scale": "f",
  "time_scale_slope": "h",
  "time_scale_profile": "m",
  "kwh_rate": 0.42818,
  "currency_type": "$"
}
```

## REST: `/api` (legacy)

Purpose: start/stop a run and fetch stats.

### `POST /api` cmd=run

Request:

```json
{ "cmd": "run", "profile": "cone-05-long-bisque" }
```

Optional: start at a specific minute in the schedule:

```json
{ "cmd": "run", "profile": "cone-05-long-bisque", "startat": 60 }
```

Response (success):

```json
{ "success": true }
```

Response (profile not found):

```json
{ "success": false, "error": "profile cone-05-long-bisque not found" }
```

Notes:

- `startat` is minutes (integer-ish) and is converted internally to seconds.
- On success, the server starts the run and begins recording a backlog for `/status`.

### `POST /api` cmd=stop

Request:

```json
{ "cmd": "stop" }
```

Response:

```json
{ "success": true }
```

### `POST /api` cmd=memo

Request:

```json
{ "cmd": "memo", "memo": "some significant message" }
```

Response:

```json
{ "success": true }
```

### `POST /api` cmd=stats

Request:

```json
{ "cmd": "stats" }
```

Response: currently returns PID stats JSON when available.

## REST: `/api/stats` (legacy)

Purpose: fetch PID stats (when available).

### `GET /api/stats`

Response body: the `pidstats` object (see `/status` examples). When not available,
the server may return an empty response.
