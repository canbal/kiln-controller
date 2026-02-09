import os
import sys
import tempfile
import unittest


sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "lib")))

from kiln_db import ensure_db, connect


class TestKilnDbMigrations(unittest.TestCase):
    def test_fresh_db_creates_version_and_tables(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = os.path.join(td, "kiln.sqlite3")
            ensure_db(db_path)

            conn = connect(db_path)
            try:
                version = conn.execute("SELECT version FROM schema_version").fetchone()[0]
                self.assertEqual(int(version), 2)

                tables = {
                    r[0]
                    for r in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
                    )
                }
                self.assertIn("schema_version", tables)
                self.assertIn("sessions", tables)
                self.assertIn("session_samples", tables)
                self.assertIn("settings", tables)
            finally:
                conn.close()

    def test_ensure_db_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = os.path.join(td, "kiln.sqlite3")
            ensure_db(db_path)
            ensure_db(db_path)

            conn = connect(db_path)
            try:
                version = conn.execute("SELECT version FROM schema_version").fetchone()[0]
                self.assertEqual(int(version), 2)
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
