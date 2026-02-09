import os
import sys
import tempfile
import unittest


sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "lib")))


from kiln_db import (
    add_session_sample,
    create_session,
    ensure_db,
    get_session,
    list_session_samples,
    list_sessions,
)


class TestKilnDbReads(unittest.TestCase):
    def test_list_sessions_orders_by_created_at_desc(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = os.path.join(td, "kiln.sqlite3")
            ensure_db(db_path)

            sid1 = create_session(db_path, profile_name="p1", created_at=100, started_at=100)
            sid2 = create_session(db_path, profile_name="p2", created_at=200, started_at=200)

            sessions = list_sessions(db_path)
            self.assertEqual(len(sessions), 2)
            self.assertEqual(sessions[0]["id"], sid2)
            self.assertEqual(sessions[1]["id"], sid1)

    def test_get_session_returns_none_for_missing(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = os.path.join(td, "kiln.sqlite3")
            ensure_db(db_path)
            self.assertIsNone(get_session(db_path, session_id="missing"))

    def test_list_session_samples_filters_and_orders(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = os.path.join(td, "kiln.sqlite3")
            ensure_db(db_path)

            sid = create_session(db_path, profile_name="p1", created_at=100, started_at=100)
            add_session_sample(db_path, session_id=sid, t=1000, state={"n": 1})
            add_session_sample(db_path, session_id=sid, t=1010, state={"n": 2})
            add_session_sample(db_path, session_id=sid, t=1020, state={"n": 3})

            all_samples = list_session_samples(db_path, session_id=sid)
            self.assertEqual([s["t"] for s in all_samples], [1000, 1010, 1020])
            self.assertEqual([s["state"]["n"] for s in all_samples], [1, 2, 3])

            one = list_session_samples(db_path, session_id=sid, from_t=1010, to_t=1010)
            self.assertEqual(len(one), 1)
            self.assertEqual(one[0]["t"], 1010)
            self.assertEqual(one[0]["state"]["n"], 2)

            tail = list_session_samples(db_path, session_id=sid, from_t=1005)
            self.assertEqual([s["t"] for s in tail], [1010, 1020])

            limited = list_session_samples(db_path, session_id=sid, limit=2)
            self.assertEqual([s["t"] for s in limited], [1000, 1010])


if __name__ == "__main__":
    unittest.main()
