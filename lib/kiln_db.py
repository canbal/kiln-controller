import os
import sqlite3
import time
import uuid
import json
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    statements: Iterable[str]


LATEST_SCHEMA_VERSION = 1


MIGRATIONS = {
    1: Migration(
        version=1,
        name="init_sessions",
        statements=(
            """
            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              created_at INTEGER NOT NULL,
              started_at INTEGER NULL,
              ended_at INTEGER NULL,
              profile_name TEXT NULL,
              outcome TEXT NULL,
              notes TEXT NULL,
              meta_json TEXT NULL
            )
            """,
            "CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at)",
            """
            CREATE TABLE IF NOT EXISTS session_samples (
              session_id TEXT NOT NULL,
              t INTEGER NOT NULL,
              state_json TEXT NOT NULL,
              PRIMARY KEY (session_id, t),
              FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
            """,
            # Redundant with the PRIMARY KEY but kept explicit for clarity.
            "CREATE INDEX IF NOT EXISTS idx_session_samples_session_id_t ON session_samples(session_id, t)",
        ),
    )
}


def _log(log, level: str, msg: str):
    if not log:
        return
    fn = getattr(log, level, None)
    if callable(fn):
        fn(msg)


def default_db_path() -> str:
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    return os.path.join(repo_root, "storage", "kiln.sqlite3")


def connect(db_path: str) -> sqlite3.Connection:
    # sqlite3 is in the standard library; this should work on Pi and macOS.
    # Use autocommit mode so we can safely manage BEGIN/COMMIT ourselves.
    conn = sqlite3.connect(db_path, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn


def _connect_configured(db_path: str) -> sqlite3.Connection:
    conn = connect(db_path)
    _configure_connection(conn)
    return conn


def ensure_db(db_path: Optional[str] = None, *, log=None) -> str:
    """Ensure a usable SQLite DB exists and is migrated.

    Returns the resolved db_path.
    """

    db_path = db_path or default_db_path()
    os.makedirs(os.path.dirname(db_path), exist_ok=True)

    conn = connect(db_path)
    try:
        _configure_connection(conn)
        _ensure_schema_version_table(conn)
        current = _get_schema_version(conn)
        if current < LATEST_SCHEMA_VERSION:
            _migrate(conn, current, log=log)
    finally:
        conn.close()

    return db_path


def create_session(
    db_path: str,
    *,
    profile_name: Optional[str],
    created_at: Optional[int] = None,
    started_at: Optional[int] = None,
    outcome: str = "RUNNING",
    meta: Optional[dict] = None,
) -> str:
    """Create a new firing session row and return its id.

    This is intentionally small and server-driven (called from Oven lifecycle).
    """

    created_at = int(created_at if created_at is not None else time.time())
    started_at = int(started_at if started_at is not None else created_at)
    sid = str(uuid.uuid4())
    meta_json = json.dumps(meta) if meta is not None else None

    conn = _connect_configured(db_path)
    try:
        conn.execute("BEGIN")
        conn.execute(
            """
            INSERT INTO sessions(id, created_at, started_at, ended_at, profile_name, outcome, notes, meta_json)
            VALUES (?, ?, ?, NULL, ?, ?, NULL, ?)
            """,
            (sid, created_at, started_at, profile_name, outcome, meta_json),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()

    return sid


def stop_session(
    db_path: str,
    *,
    session_id: str,
    ended_at: Optional[int] = None,
    outcome: str,
) -> bool:
    """Mark a session ended.

    Returns True if a row was updated. Idempotent for already-ended sessions.
    """

    ended_at = int(ended_at if ended_at is not None else time.time())

    conn = _connect_configured(db_path)
    try:
        conn.execute("BEGIN")
        cur = conn.execute(
            """
            UPDATE sessions
            SET ended_at = ?, outcome = ?
            WHERE id = ? AND ended_at IS NULL
            """,
            (ended_at, outcome, session_id),
        )
        conn.execute("COMMIT")
        return bool(cur.rowcount)
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def add_session_sample(
    db_path: str,
    *,
    session_id: str,
    state: dict,
    t: Optional[int] = None,
) -> None:
    """Persist one sample row for a session.

    - `t` is stored as unix seconds (INTEGER).
    - `state_json` stores the full `Oven.get_state()` payload.

    Uses INSERT OR REPLACE so repeated writes in the same second don't fail.
    """

    sample_t = int(t if t is not None else time.time())
    state_json = json.dumps(state, ensure_ascii=True, separators=(",", ":"), sort_keys=True)

    conn = _connect_configured(db_path)
    try:
        conn.execute("BEGIN")
        conn.execute(
            """
            INSERT OR REPLACE INTO session_samples(session_id, t, state_json)
            VALUES (?, ?, ?)
            """,
            (session_id, sample_t, state_json),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def list_sessions(
    db_path: str,
    *,
    limit: int = 50,
    offset: int = 0,
) -> List[Dict[str, Any]]:
    """List sessions ordered by created_at desc.

    Returned objects intentionally omit large fields like meta_json/state.
    """

    limit_i = int(limit)
    offset_i = int(offset)
    if limit_i <= 0:
        limit_i = 50
    if limit_i > 500:
        limit_i = 500
    if offset_i < 0:
        offset_i = 0

    conn = _connect_configured(db_path)
    try:
        rows = list(
            conn.execute(
                """
                SELECT id, created_at, started_at, ended_at, profile_name, outcome
                FROM sessions
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
                """,
                (limit_i, offset_i),
            )
        )
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_session(
    db_path: str,
    *,
    session_id: str,
) -> Optional[Dict[str, Any]]:
    """Fetch a single session by id, or None if not found."""

    conn = _connect_configured(db_path)
    try:
        row = conn.execute(
            """
            SELECT id, created_at, started_at, ended_at, profile_name, outcome, notes
            FROM sessions
            WHERE id = ?
            """,
            (session_id,),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def update_session_notes(
    db_path: str,
    *,
    session_id: str,
    notes: Optional[str],
) -> bool:
    """Update a session's notes field.

    Returns True if a row was updated.
    """

    conn = _connect_configured(db_path)
    try:
        conn.execute("BEGIN")
        cur = conn.execute(
            """
            UPDATE sessions
            SET notes = ?
            WHERE id = ?
            """,
            (notes, session_id),
        )
        conn.execute("COMMIT")
        return bool(cur.rowcount)
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def list_session_samples(
    db_path: str,
    *,
    session_id: str,
    from_t: Optional[int] = None,
    to_t: Optional[int] = None,
    limit: int = 500,
) -> List[Dict[str, Any]]:
    """List samples for a session, optionally bounded by unix seconds.

    - from_t/to_t are inclusive bounds on the INTEGER 't' column.
    - Results are ordered by t asc.
    - The returned rows include parsed 'state' JSON.
    """

    limit_i = int(limit)
    if limit_i <= 0:
        limit_i = 500
    if limit_i > 5000:
        limit_i = 5000

    where = ["session_id = ?"]
    params: List[Any] = [session_id]
    if from_t is not None:
        where.append("t >= ?")
        params.append(int(from_t))
    if to_t is not None:
        where.append("t <= ?")
        params.append(int(to_t))

    params.append(limit_i)

    conn = _connect_configured(db_path)
    try:
        rows = list(
            conn.execute(
                """
                SELECT t, state_json
                FROM session_samples
                WHERE {where_sql}
                ORDER BY t ASC
                LIMIT ?
                """.format(where_sql=" AND ".join(where)),
                tuple(params),
            )
        )

        out: List[Dict[str, Any]] = []
        for r in rows:
            try:
                state = json.loads(r["state_json"])
            except Exception:
                state = None
            out.append({"t": int(r["t"]), "state": state})
        return out
    finally:
        conn.close()


def _configure_connection(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 5000")


def _ensure_schema_version_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER NOT NULL
        )
        """
    )


def _get_schema_version(conn: sqlite3.Connection) -> int:
    rows = list(conn.execute("SELECT version FROM schema_version"))
    if not rows:
        conn.execute("INSERT INTO schema_version(version) VALUES (0)")
        return 0

    # If multiple rows exist for any reason, pick the max and collapse to one.
    versions = [int(r[0]) for r in rows]
    v = max(versions)
    if len(versions) != 1:
        conn.execute("DELETE FROM schema_version")
        conn.execute("INSERT INTO schema_version(version) VALUES (?)", (v,))
    return v


def _set_schema_version(conn: sqlite3.Connection, version: int) -> None:
    conn.execute("DELETE FROM schema_version")
    conn.execute("INSERT INTO schema_version(version) VALUES (?)", (int(version),))


def _migrate(conn: sqlite3.Connection, current_version: int, *, log=None) -> None:
    start = time.time()
    _log(log, "info", f"SQLite: migrating schema from v{current_version} to v{LATEST_SCHEMA_VERSION}")

    # Single-writer lock: keep migrations serialized if multiple processes start.
    conn.execute("BEGIN IMMEDIATE")
    try:
        current = _get_schema_version(conn)
        for target in range(current + 1, LATEST_SCHEMA_VERSION + 1):
            mig = MIGRATIONS.get(target)
            if not mig:
                raise RuntimeError(f"Missing migration for schema version {target}")

            _log(log, "info", f"SQLite: applying v{mig.version} ({mig.name})")
            for stmt in mig.statements:
                conn.execute(stmt)
            _set_schema_version(conn, mig.version)

        conn.execute("COMMIT")
    except Exception as e:
        conn.execute("ROLLBACK")
        _log(log, "error", f"SQLite: migration failed: {e}")
        raise
    else:
        elapsed_ms = int((time.time() - start) * 1000)
        _log(log, "info", f"SQLite: migrations complete in {elapsed_ms}ms")
