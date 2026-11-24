"""Tests of extract_gate.py and common.legs() on small synthetic inputs, never real archive data.
Run from the repository root: python -I -B test/test_extract_gate.py"""
import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "python"))
sys.path.insert(0, str(HERE))
import extract_gate as g  # noqa: E402
from test_extract_world import airport, plane, row, tar_part  # noqa: E402


class LegsTest(unittest.TestCase):
    def setUp(self):
        self.airports = [airport("KAAA", -100.0, 40.0), airport("KBBB", -94.0, 40.0)]

    def flight_rows(self, flight="DAL123", gap_s=60, ground=True):
        rows = [row(-30, 40.0, -100.0, "ground", flight=None)] if ground else []
        for i in range(61):
            rows.append(row(i * gap_s, 40.0, -99.99 + i * 0.1, 30000, flight=flight))
        if ground:
            rows.append(row(60 * gap_s + 30, 40.0, -94.0, "ground", flight=None))
        return rows

    def legs(self, rows):
        return list(g.holdout.legs({"icao": "abc123", "t": "A320", "timestamp": 1000.0, "trace": rows}, self.airports))

    def test_a_ground_to_ground_leg_between_two_airports(self):
        found = self.legs(self.flight_rows())
        self.assertEqual(len(found), 1)
        self.assertEqual((found[0]["route"], found[0]["origin"], found[0]["destination"]), ("AAA-BBB", [-100.0, 40.0], [-94.0, 40.0]))
        self.assertEqual(found[0]["firstAirMs"], 1_000_000)

    def test_needs_ground_reports_a_listed_operator_one_callsign_and_no_long_gap(self):
        self.assertEqual(self.legs(self.flight_rows(ground=False)), [])
        self.assertEqual(self.legs(self.flight_rows(flight="FDX9")), [])
        self.assertEqual(self.legs(self.flight_rows(gap_s=601)), [])
        mixed = self.flight_rows()
        mixed[5][8] = {"flight": "DAL999"}
        self.assertEqual(self.legs(mixed), [])

    def test_a_leg_under_60_km_is_dropped(self):
        close = [airport("KAAA", -100.0, 40.0), airport("KBBB", -99.9, 40.0)]
        rows = [row(-30, 40.0, -100.0, "ground", flight=None)] + [row(i * 60, 40.0, -99.99 + i * 0.001, 30000) for i in range(21)] + [row(1290, 40.0, -99.9, "ground", flight=None)]
        self.assertEqual(list(g.holdout.legs({"icao": "x", "t": "A320", "timestamp": 0.0, "trace": rows}, close)), [])


class ExtractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "root"
        self.out = Path(self.tmp.name) / "out"
        self.day = "2025.03.26"
        airports = Path(self.tmp.name) / "airports.json"
        airports.write_text(json.dumps({"rows": [airport("KAAA", -100.0, 40.0), airport("KBBB", -94.0, 40.0)]}), encoding="utf8")
        self.airports = airports
        self.old_sha = g.holdout.AIRPORT_SHA
        g.holdout.AIRPORT_SHA = hashlib.sha256(airports.read_bytes()).hexdigest()
        self.addCleanup(setattr, g.holdout, "AIRPORT_SHA", self.old_sha)

    def install(self):
        folder = g.archive.day_dir(self.root, self.day)
        folder.mkdir(parents=True)
        rows = [row(-30, 40.0, -100.0, "ground", flight=None)] + [row(i * 60, 40.0, -99.99 + i * 0.1, 30000) for i in range(61)] + [row(3630, 40.0, -94.0, "ground", flight=None)]
        data = tar_part([("./traces/aa/trace_full_abc123.json", plane(rows))])
        parts = {}
        for suffix, piece in (("aa", data[:len(data) // 2]), ("ab", data[len(data) // 2:])):
            name = g.archive.part_names(self.day)[suffix]
            (folder / name).write_bytes(piece)
            parts[name] = {"size": len(piece), "sha256": hashlib.sha256(piece).hexdigest()}
        (folder / "manifest.json").write_text(json.dumps({"day": self.day, "release": g.archive.tag(self.day), "parts": parts}), encoding="utf8")

    def test_writes_a_leg_with_no_callsign_and_a_60_second_line(self):
        self.install()
        target = g.extract(self.root, self.airports, self.day, self.out)
        text = target.read_text(encoding="utf8")
        leg = json.loads(text)
        self.assertEqual(set(leg), {"day", "release", "originIcao", "destinationIcao", "origin", "destination", "distanceKm",
                                    "firstAirMs", "lastAirMs", "region", "line"})
        self.assertEqual((leg["originIcao"], leg["destinationIcao"], leg["region"]), ("KAAA", "KBBB", "US"))
        self.assertEqual(len(leg["line"]), 61)
        self.assertNotIn("DAL123", text)
        self.assertNotIn("abc123", text)

    def test_a_wrong_airport_index_is_refused(self):
        self.install()
        g.holdout.AIRPORT_SHA = "0" * 64
        with self.assertRaises(ValueError):
            g.extract(self.root, self.airports, self.day, self.out)

    def test_another_airport_index_needs_the_explicit_option_and_warns(self):
        self.install()
        g.holdout.AIRPORT_SHA = "0" * 64
        with self.assertRaises(ValueError):
            g.extract(self.root, self.airports, self.day, self.out)
        with contextlib.redirect_stderr(io.StringIO()) as err:
            target = g.extract(self.root, self.airports, self.day, self.out, "any")
        self.assertIn("WARNING", err.getvalue())
        self.assertIn("will not match", err.getvalue())
        self.assertTrue(target.exists())

    def test_a_part_that_does_not_match_the_manifest_is_refused(self):
        self.install()
        name = next(iter(g.archive.part_names(self.day).values()))
        path = g.archive.day_dir(self.root, self.day) / name
        path.write_bytes(path.read_bytes() + b"x")
        with self.assertRaises(ValueError):
            g.extract(self.root, self.airports, self.day, self.out)


if __name__ == "__main__":
    unittest.main()
