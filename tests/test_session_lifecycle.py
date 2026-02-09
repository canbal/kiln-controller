import os
import sys
import json
import tempfile
import unittest


sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "lib")))

import config
from kiln_db import ensure_db, connect
from oven import Oven, Profile


class _FakeTempSensor:
    def __init__(self):
        self.temperature = 70
        self.noConnection = False
        self.shortToGround = False
        self.shortToVCC = False
        self.unknownError = False
        self.bad_percent = 0


class _FakeBoard:
    def __init__(self):
        self.temp_sensor = _FakeTempSensor()


class TestSessionLifecycle(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self._td.name, "kiln.sqlite3")
        ensure_db(self.db_path)

        self._old_sqlite_db_path = getattr(config, "sqlite_db_path", None)
        self._old_automatic_restarts = getattr(config, "automatic_restarts", True)
        config.sqlite_db_path = self.db_path
        config.automatic_restarts = False

    def tearDown(self):
        config.sqlite_db_path = self._old_sqlite_db_path
        config.automatic_restarts = self._old_automatic_restarts
        self._td.cleanup()

    def _get_only_session(self):
        conn = connect(self.db_path)
        try:
            rows = list(
                conn.execute(
                    "SELECT id, profile_name, started_at, ended_at, outcome FROM sessions ORDER BY created_at"
                )
            )
            self.assertEqual(len(rows), 1)
            return dict(rows[0])
        finally:
            conn.close()

    def test_run_creates_session_with_profile_name(self):
        oven = Oven()
        oven.board = _FakeBoard()

        profile = Profile(json.dumps({"name": "test_profile", "data": [[0, 70], [60, 100]]}))
        oven.run_profile(profile)

        sess = self._get_only_session()
        self.assertEqual(sess["profile_name"], "test_profile")
        self.assertEqual(sess["outcome"], "RUNNING")
        self.assertIsNotNone(sess["started_at"])
        self.assertIsNone(sess["ended_at"])

    def test_stop_marks_session_ended(self):
        oven = Oven()
        oven.board = _FakeBoard()

        profile = Profile(json.dumps({"name": "test_profile", "data": [[0, 70], [60, 100]]}))
        oven.run_profile(profile)
        oven.abort_run()

        sess = self._get_only_session()
        self.assertEqual(sess["outcome"], "ABORTED")
        self.assertIsNotNone(sess["ended_at"])

    def test_schedule_end_marks_session_completed(self):
        oven = Oven()
        oven.board = _FakeBoard()

        profile = Profile(json.dumps({"name": "test_profile", "data": [[0, 70], [60, 100]]}))
        oven.run_profile(profile)

        oven.runtime = oven.totaltime + 1
        oven.reset_if_schedule_ended()

        sess = self._get_only_session()
        self.assertEqual(sess["outcome"], "COMPLETED")
        self.assertIsNotNone(sess["ended_at"])


if __name__ == "__main__":
    unittest.main()
