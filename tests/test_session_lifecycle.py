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
        self._old_temp_scale = getattr(config, "temp_scale", "f")
        config.sqlite_db_path = self.db_path
        config.automatic_restarts = False
        config.temp_scale = "f"

    def tearDown(self):
        config.sqlite_db_path = self._old_sqlite_db_path
        config.automatic_restarts = self._old_automatic_restarts
        config.temp_scale = self._old_temp_scale
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

    def test_cooldown_capture_persists_samples_until_threshold(self):
        oven = Oven()
        oven.board = _FakeBoard()
        oven.board.temp_sensor.temperature = 500

        profile = Profile(json.dumps({"name": "test_profile", "data": [[0, 70], [60, 100]]}))
        oven.run_profile(profile)

        oven.runtime = oven.totaltime + 1
        oven.reset_if_schedule_ended()

        sess = self._get_only_session()
        self.assertEqual(sess["outcome"], "COMPLETED")
        self.assertIsNotNone(oven._cooldown_session_id)

        st0 = oven.get_state()
        self.assertTrue(st0.get("cooldown_active"))
        self.assertEqual(st0.get("cooldown_session_id"), sess["id"])
        self.assertIn("cooldown_elapsed", st0)

        # Persist once while temp is still above the threshold (200F for temp_scale='f').
        oven._cooldown_capture_tick()

        conn = connect(self.db_path)
        try:
            rows = list(
                conn.execute(
                    "SELECT session_id, t, state_json FROM session_samples WHERE session_id = ? ORDER BY t",
                    (sess["id"],),
                )
            )
            self.assertEqual(len(rows), 1)
            state = json.loads(rows[0]["state_json"])
            self.assertEqual(state["state"], "IDLE")
            self.assertIn("temperature", state)
        finally:
            conn.close()

        # Once below threshold, capture should persist one final sample and stop.
        oven.board.temp_sensor.temperature = 150
        oven._cooldown_capture_tick()
        self.assertIsNone(oven._cooldown_session_id)

        conn = connect(self.db_path)
        try:
            rows2 = list(
                conn.execute(
                    "SELECT session_id, t FROM session_samples WHERE session_id = ? ORDER BY t",
                    (sess["id"],),
                )
            )
            # Note: samples are stored at 1-second resolution and use INSERT OR REPLACE,
            # so two ticks within the same second can collapse to a single row.
            self.assertEqual(len(rows2), 1)

            state2_json = conn.execute(
                "SELECT state_json FROM session_samples WHERE session_id = ? ORDER BY t DESC LIMIT 1",
                (sess["id"],),
            ).fetchone()[0]
            state2 = json.loads(state2_json)
            self.assertLess(state2["temperature"], 200)
        finally:
            conn.close()

    def test_cooldown_capture_stops_after_48h_cap(self):
        oven = Oven()
        oven.board = _FakeBoard()
        oven.board.temp_sensor.temperature = 500

        profile = Profile(json.dumps({"name": "test_profile", "data": [[0, 70], [60, 100]]}))
        oven.run_profile(profile)

        oven.runtime = oven.totaltime + 1
        oven.reset_if_schedule_ended()

        # Force cap to have already expired.
        oven._cooldown_until_ts = 0
        oven._cooldown_capture_tick()
        self.assertIsNone(oven._cooldown_session_id)

        sess = self._get_only_session()
        conn = connect(self.db_path)
        try:
            rows = list(
                conn.execute(
                    "SELECT session_id, t FROM session_samples WHERE session_id = ? ORDER BY t",
                    (sess["id"],),
                )
            )
            self.assertEqual(len(rows), 0)
        finally:
            conn.close()

    def test_manual_stop_cooldown_capture(self):
        oven = Oven()
        oven.board = _FakeBoard()
        oven.board.temp_sensor.temperature = 500

        profile = Profile(json.dumps({"name": "test_profile", "data": [[0, 70], [60, 100]]}))
        oven.run_profile(profile)

        oven.runtime = oven.totaltime + 1
        oven.reset_if_schedule_ended()
        self.assertIsNotNone(oven._cooldown_session_id)

        stopped = oven.stop_cooldown_capture()
        self.assertTrue(stopped)
        self.assertIsNone(oven._cooldown_session_id)

    def test_persist_sample_writes_session_samples_row(self):
        oven = Oven()
        oven.board = _FakeBoard()

        profile = Profile(json.dumps({"name": "test_profile", "data": [[0, 70], [60, 100]]}))
        oven.run_profile(profile)

        oven._persist_sample_if_possible()

        conn = connect(self.db_path)
        try:
            sess = self._get_only_session()
            rows = list(
                conn.execute(
                    "SELECT session_id, t, state_json FROM session_samples WHERE session_id = ? ORDER BY t",
                    (sess["id"],),
                )
            )
            self.assertEqual(len(rows), 1)

            state = json.loads(rows[0]["state_json"])
            self.assertEqual(state["state"], "RUNNING")
            self.assertEqual(state["profile"], "test_profile")
            self.assertIn("temperature", state)
            self.assertIn("target", state)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
