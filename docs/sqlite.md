# SQLite (Sessions Storage)

The modern UI workstream stores firing session history in a single local SQLite file.

## Location

- Default path: `storage/kiln.sqlite3`
- Config override: `config.sqlite_db_path`

The file is created automatically on server startup.

## Schema Versioning

The DB includes a `schema_version` table containing a single integer `version`.
On startup, the server applies any missing migrations to reach the latest supported version.

## Initial Tables

- `sessions`
- `session_samples`

These are currently additive infrastructure for upcoming tasks; legacy UI endpoints remain unchanged.

## Resetting (Development Only)

Stop the server, then remove the DB file:

```bash
rm -f storage/kiln.sqlite3 storage/kiln.sqlite3-*
```

Restart the server to recreate the DB.
