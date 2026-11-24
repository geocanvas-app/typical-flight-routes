"""Tests of extract_world.py on small synthetic inputs, never real archive data.
Run from the repository root: python -I -B test/test_extract_world.py"""
import contextlib
import gzip
import hashlib
import io
import json
import math
import sys
import tarfile
import tempfile
import unittest
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "python"))
import extract_world as w  # noqa: E402


def airport(icao, lon, lat, size=1, elev=0, sched=1, iata=None, country="US"):
    return [iata if iata is not None else icao[1:], icao, "n", "c", country, lon, lat, size, "UTC", elev, sched]


def sample(t, lat, lon, alt, flight="DAL123"):
    return (0, t, lat, lon, alt, flight)


def row(t, lat, lon, alt, flight="DAL123", source="adsb_icao"):
    return [t, lat, lon, alt, 400, 90, 0, 0, {"flight": flight} if flight else {}, source]


def km_lon(km, lat):
    return km / (111.195 * math.cos(math.radians(lat)))


class MatcherTest(unittest.TestCase):
    def grid(self, *rows):
        return w.build_grid(w.candidates(list(rows)))

    def test_candidates_need_codes_size_and_scheduled_service(self):
        rows = [airport("KAAA", 0, 0), airport("KBBB", 0, 0, size=2), airport("KCCC", 0, 0, sched=0), airport("KDDD", 0, 0, iata=""),
                airport("KEEE", 0, 0, size=0)]
        self.assertEqual([a[1] for a in w.candidates(rows)], ["KAAA", "KEEE"])

    def test_accepts_the_only_close_airport_and_gives_no_icao_far_away(self):
        g = self.grid(airport("KAAA", -100.0, 40.0))
        self.assertEqual(w.match_airport(g, -100.0, 40.1, 1000), "KAAA")
        self.assertIsNone(w.match_airport(g, -100.0, 40.0 + 31 / 111.195, 1000))
        self.assertEqual(w.match_airport(g, -100.0, 40.0 + 29 / 111.195, 1000), "KAAA")

    def test_altitude_above_the_field_limit_uses_elevation_and_blank_is_zero(self):
        g = self.grid(airport("KAAA", -100.0, 40.0, elev=1000), airport("KBBB", -50.0, 10.0, elev=None))
        self.assertEqual(w.match_airport(g, -100.0, 40.0, 4000), "KAAA")
        self.assertIsNone(w.match_airport(g, -100.0, 40.0, 4001))
        self.assertEqual(w.match_airport(g, -50.0, 10.0, 3000), "KBBB")
        self.assertIsNone(w.match_airport(g, -50.0, 10.0, 3001))

    def test_second_airport_must_be_three_times_as_far(self):
        step = 1 / 111.195  # one km of latitude
        g = self.grid(airport("KAAA", -100.0, 40.0), airport("KBBB", -100.0, 40.0 + 40 * step))
        self.assertEqual(w.match_airport(g, -100.0, 40.0 + 9.8 * step, 1000), "KAAA")  # 9.8 vs 30.2 km: just over three times
        self.assertIsNone(w.match_airport(g, -100.0, 40.0 + 10.2 * step, 1000))  # 10.2 vs 29.8 km: just under
        self.assertIsNone(w.match_airport(g, -100.0, 40.0 + 20 * step, 1000))

    def test_searches_the_neighbouring_cells(self):
        g = self.grid(airport("KAAA", -99.999, 40.001))
        self.assertEqual(w.match_airport(g, -100.001, 39.999, 500), "KAAA")

    def test_searches_across_the_date_line(self):
        g = self.grid(airport("NFFF", -179.99, 10.0))
        self.assertEqual(w.match_airport(g, 179.99, 10.0, 500), "NFFF")


class RegionTest(unittest.TestCase):
    def test_prefix_order(self):
        cases = {
            "KJFK": "North America", "CYYZ": "North America", "PANC": "North America", "PHNL": "North America",
            "MMMX": "Central America/Caribbean", "TJSJ": "Central America/Caribbean", "SBGR": "South America",
            "UUEE": "Russia/CIS", "OMDB": "Middle East", "FACT": "Africa", "DNMM": "Africa", "GOBD": "Africa", "HKJK": "Africa",
            "EGLL": "Europe", "LFPG": "Europe", "BIKF": "Europe",
            "VTBS": "Southeast Asia", "VVTS": "Southeast Asia", "VLVT": "Southeast Asia", "VDPP": "Southeast Asia",
            "VYYY": "Southeast Asia", "RPLL": "Southeast Asia", "WSSS": "Southeast Asia",
            "VHHH": "East Asia", "VMMC": "East Asia", "ZBAA": "East Asia", "RJTT": "East Asia", "RKSI": "East Asia",
            "VIDP": "South Asia", "VCBI": "South Asia", "VGHS": "South Asia",
            "YSSY": "Oceania/Pacific", "NZAA": "Oceania/Pacific", "AGGH": "Oceania/Pacific", "PGUM": "Oceania/Pacific",
            "XXXX": "other",
        }
        for icao, expected in cases.items():
            self.assertEqual(w.region_of(icao), expected, icao)

    def test_a_leg_counts_in_every_region_it_touches_once(self):
        self.assertEqual(w.leg_regions("KJFK", "KBOS"), ["North America"])
        self.assertEqual(w.leg_regions("KJFK", "EGLL"), ["Europe", "North America"])

    def test_rest_of_world_is_any_region_other_than_north_america_and_europe(self):
        self.assertFalse(w.touches_rest_of_world(["Europe", "North America"]))
        self.assertTrue(w.touches_rest_of_world(["Europe", "Middle East"]))


class OperatorTest(unittest.TestCase):
    def test_world_list_is_exactly_the_documented_list(self):
        protocol = (HERE.parent / "docs" / "method.md").read_text(encoding="utf8")
        listed = [line for line in protocol.splitlines() if line.startswith("`") and line.endswith("`")]
        self.assertEqual(len(listed), 1)
        codes = listed[0].strip("`").split()
        self.assertEqual(len(codes), len(set(codes)))
        self.assertEqual(w.WORLD_OPERATORS, set(codes))
        self.assertNotIn("FDX", w.WORLD_OPERATORS)
        self.assertNotIn("DAL", w.WORLD_OPERATORS)  # DAL comes from common.OPERATORS


def at(times, east_km):
    """Samples at the given times, east_km east of -100 along 40 N."""
    return [sample(t, 40.0, -100.0 + km_lon(km, 40.0), 10000) for t, km in zip(times, east_km)]


def straight(n=6, step_s=60, t0=1000.0, lat=40.0, lon0=-100.0, dlon=0.05, alt=10000, flight="DAL123"):
    return [sample(t0 + i * step_s, lat, lon0 + i * dlon, alt, flight) for i in range(n)]


class SegmentTest(unittest.TestCase):
    def test_a_ground_row_ends_a_segment_and_other_sources_are_skipped(self):
        rows = [row(0, 40, -100, 1000), row(60, 40, -99.9, 1000), row(90, 40, -99.85, 1000, source="mlat"),
                row(120, 40, -99.8, 1000), row(150, 40, -99.7, "ground"), row(180, 40, -99.6, 1000), row(240, 40, -99.5, 1000)]
        segs = w.segments(rows, 0)
        self.assertEqual([[s[1] for s in seg] for seg in segs], [[0, 60, 120], [180, 240]])

    def test_a_gap_over_1200_seconds_ends_a_segment_but_1200_does_not(self):
        rows = [row(0, 40, -100, 1000), row(1200, 40, -99.9, 1000), row(2401, 40, -99.8, 1000)]
        segs = w.segments(rows, 0)
        self.assertEqual([[s[1] for s in seg] for seg in segs], [[0, 1200], [2401]])

    def test_a_non_numeric_altitude_is_not_a_sample(self):
        rows = [row(0, 40, -100, 1000), row(60, 40, -99.9, None), row(120, 40, -99.8, 1000)]
        self.assertEqual([[s[1] for s in seg] for seg in w.segments(rows, 0)], [[0, 120]])

    def test_the_timestamp_is_added(self):
        self.assertEqual(w.segments([row(5, 40, -100, 1000)], 1000)[0][0][1], 1005)

    def test_reject_reasons_short_and_gap(self):
        self.assertIsNone(w.reject_reason(at([0, 60, 120, 180, 240], [0] * 5)))
        self.assertEqual(w.reject_reason(at([0, 60, 120, 180], [0] * 4)), "short")
        self.assertIsNone(w.reject_reason(at([0, 100, 200, 800, 900], [0] * 5)))  # a 600 s step is allowed
        self.assertEqual(w.reject_reason(at([0, 100, 200, 801, 901], [0] * 5)), "gap")  # 601 s is not

    def test_speed_over_1300_kmh_between_samples_more_than_50_km_apart(self):
        # 100 km in 270 s = 1,333 km/h; in 290 s = 1,241 km/h
        self.assertEqual(w.reject_reason(at([0, 60, 120, 390, 450], [0, 0, 0, 100, 100])), "speed")
        self.assertIsNone(w.reject_reason(at([0, 60, 120, 410, 470], [0, 0, 0, 100, 100])))

    def test_a_non_positive_time_step_over_50_km_counts_as_too_fast(self):
        self.assertEqual(w.reject_reason(at([0, 60, 120, 120, 180], [0, 0, 0, 60, 60])), "speed")
        self.assertEqual(w.reject_reason(at([0, 60, 120, 100, 180], [0, 0, 0, 60, 60])), "speed")
        self.assertIsNone(w.reject_reason(at([0, 60, 120, 120, 180], [0, 0, 0, 30, 30])))  # a duplicate stamp under 50 km is no speed

    def test_callsign_rules(self):
        ok = straight(6, flight="DAL123")
        self.assertEqual(w.callsign_of(ok), "DAL123")
        self.assertEqual(w.callsign_of(straight(6, flight="JIA4567")), "JIA4567")  # a world operator
        self.assertIsNone(w.callsign_of(straight(6, flight="FDX123")))  # not listed
        self.assertIsNone(w.callsign_of(straight(6, flight="DAL")))  # no digit
        self.assertIsNone(w.callsign_of(straight(6, flight="DAL1234567")))  # too long
        self.assertIsNone(w.callsign_of(straight(6, flight=None)))
        mixed = straight(6, flight="DAL123")
        mixed[2] = mixed[2][:5] + ("DAL124",)
        self.assertIsNone(w.callsign_of(mixed))
        blanks = straight(6, flight="DAL123")
        blanks[2] = blanks[2][:5] + (None,)
        self.assertEqual(w.callsign_of(blanks), "DAL123")


class LegTest(unittest.TestCase):
    def setUp(self):
        self.a, self.b = airport("KAAA", -100.0, 40.0), airport("KBBB", -94.0, 40.0)  # about 511 km
        self.grid = w.build_grid(w.candidates([self.a, self.b]))
        self.where = {"KAAA": (-100.0, 40.0), "KBBB": (-94.0, 40.0)}

    def flight(self, n=61, dlon=0.1, step=60, alt_start=500, lon0=-99.99):
        return [sample(1000.0 + i * step, 40.0, lon0 + i * dlon, alt_start if i in (0, n - 1) else 30000, "DAL123") for i in range(n)]

    def test_a_good_leg(self):
        leg, reason = w.make_leg(self.flight(), self.grid, self.where)
        self.assertIsNone(reason)
        self.assertEqual((leg["originIcao"], leg["destinationIcao"]), ("KAAA", "KBBB"))
        self.assertEqual(leg["origin"], [-100.0, 40.0])
        self.assertAlmostEqual(leg["distanceKm"], 511.0, delta=2)
        self.assertEqual((leg["firstAirMs"], leg["lastAirMs"]), (1000000, 1000000 + 3600000))

    def test_the_distance_is_not_rounded_so_a_band_edge_stays_on_its_side(self):
        a, b = airport("KAAA", -100.0, 40.0), airport("KBBB", -94.0, 40.0)
        leg, _ = w.make_leg(self.flight(), w.build_grid(w.candidates([a, b])), self.where)
        self.assertEqual(leg["distanceKm"], w.distance_km(self.where["KAAA"], self.where["KBBB"]))
        self.assertNotEqual(leg["distanceKm"], round(leg["distanceKm"], 3))

    def test_each_rule_names_its_reason(self):
        self.assertEqual(w.make_leg(self.flight(4), self.grid, self.where)[1], "short")
        self.assertEqual(w.make_leg([s[:5] + ("FDX1",) for s in self.flight()], self.grid, self.where)[1], "callsign")
        high = self.flight(alt_start=9000)
        self.assertEqual(w.make_leg(high, self.grid, self.where)[1], "unmatched")
        self.assertEqual(w.make_leg(self.flight(lon0=-90.0), self.grid, self.where)[1], "unmatched")

    def test_same_airport_distance_and_duration(self):
        loop = [sample(1000.0 + i * 60, 40.0, -99.99 + 0.1 * min(i, 60 - i), 500 if i in (0, 60) else 30000) for i in range(61)]
        self.assertEqual(w.make_leg(loop, self.grid, self.where)[1], "sameAirport")
        near = airport("KCCC", -99.0, 40.0)  # 85 km from KAAA
        grid = w.build_grid(w.candidates([self.a, near]))
        where = {"KAAA": (-100.0, 40.0), "KCCC": (-99.0, 40.0)}
        short = self.flight(n=11, dlon=0.1)
        self.assertEqual(w.make_leg(short, grid, where)[1], "distance")
        far = airport("KDDD", -77.0, 40.0)  # about 1,960 km
        grid = w.build_grid(w.candidates([self.a, far]))
        where = {"KAAA": (-100.0, 40.0), "KDDD": (-77.0, 40.0)}
        self.assertIsNone(w.make_leg(self.flight(n=231, dlon=0.1, step=60, lon0=-99.99), grid, where)[1])
        too_far = airport("KEEE", -76.0, 40.0)  # over 2,000 km
        grid = w.build_grid(w.candidates([self.a, too_far]))
        self.assertEqual(w.make_leg(self.flight(n=241, dlon=0.1, step=60, lon0=-99.99), grid, {"KAAA": (-100.0, 40.0), "KEEE": (-76.0, 40.0)})[1], "distance")

    def test_distance_bounds_are_250_inclusive_and_2000_exclusive(self):
        self.assertTrue(w.distance_ok(250.0))
        self.assertFalse(w.distance_ok(249.999))
        self.assertTrue(w.distance_ok(1999.999))
        self.assertFalse(w.distance_ok(2000.0))

    def test_under_ten_minutes_is_rejected_and_ten_minutes_is_kept(self):
        a = airport("KAAA", -100.0, 40.0)
        b = airport("KFFF", -97.0, 40.0)  # 255 km
        grid = w.build_grid(w.candidates([a, b]))
        where = {"KAAA": (-100.0, 40.0), "KFFF": (-97.0, 40.0)}
        # seven samples 42.6 km apart (under the 50 km speed rule), spanning 598.8 s, then 600 s
        def flown(step):
            return [sample(1000.0 + i * step, 40.0, -99.995 + i * 0.5, 500 if i in (0, 6) else 30000) for i in range(7)]
        self.assertEqual(w.make_leg(flown(99.8), grid, where)[1], "duration")
        self.assertIsNone(w.make_leg(flown(100.0), grid, where)[1])


class GroundedAndCheckTest(unittest.TestCase):
    def test_grounded_needs_a_ground_row_within_60_seconds_on_each_side(self):
        rows = [row(0, 40, -100, "ground"), row(30, 40, -100, 0, source="mlat"), row(60, 40, -100, 300), row(120, 40, -99.9, 600),
                row(180, 40, -99.8, 300), row(230, 40, -99.7, "ground")]
        first, last = rows[2], rows[4]
        self.assertIs(w.ground_row(rows, 2, -1, 60, 0), rows[0])
        self.assertIs(w.ground_row(rows, 4, 1, 180, 0), rows[5])
        self.assertIsNone(w.ground_row(rows, 4, 1, 100, 0))  # 130 s after: out of reach

    def test_a_ground_row_exactly_60_seconds_out_counts_and_61_does_not(self):
        rows = [row(0, 40, -100, "ground"), row(60, 40, -100, 300), row(121, 40, -100, "ground")]
        self.assertIsNotNone(w.ground_row(rows, 1, -1, 60, 0))
        self.assertIsNone(w.ground_row(rows, 1, 1, 60, 0))

    def test_matcher_check_outcomes(self):
        field = airport("KAAA", -100.0, 40.0, elev=1000)
        full = w.build_grid([field])
        match = w.build_grid(w.candidates([field]))
        ground = row(0, 40.0005, -100.0005, "ground")
        right = [sample(0, 40.0, -100.0, 1500), sample(60, 40.0, -100.0, 3200), sample(120, 40.0, -100.0, 5000)]
        # the first sample 2,000 ft above the 1,000 ft field is 3,000 ft; the one at 3200 is the first >= 3,000
        self.assertEqual(w.check_end(right, ground, match, full), "right")
        self.assertEqual(w.check_end([sample(0, 40.0, -100.0, 2900), sample(60, 40.0, -100.0, 2999)], ground, match, full), "rejected")
        self.assertEqual(w.check_end(right, None, match, full), "noTruth")
        far = row(0, 41.0, -100.0, "ground")
        self.assertEqual(w.check_end(right, far, match, full), "noTruth")
        # the matcher refuses the sample at 4,100 ft up (above its 3,000 ft limit): rejected
        self.assertEqual(w.check_end([sample(0, 40.0, -100.0, 4100)], ground, match, full), "rejected")

    def test_matcher_check_counts_a_wrong_airport(self):
        near = airport("KAAA", -100.0, 40.0)
        other = airport("KBBB", -100.0, 40.0 + 12 / 111.195, size=2)  # size 2 is small: not a matcher candidate, but the true field
        full = w.build_grid([near, other])
        match = w.build_grid(w.candidates([near, other]))
        ground = row(0, 40.0 + 12 / 111.195, -100.0, "ground")
        self.assertEqual(w.check_end([sample(0, 40.0 + 12 / 111.195, -100.0, 2500)], ground, match, full), "wrong")


def tar_part(members):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as tar:
        for name, payload in members:
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
    return buffer.getvalue()


def plane(rows, timestamp=1_700_000_000.0, jet="A320"):
    return gzip.compress(json.dumps({"t": jet, "icao": "abc123", "timestamp": timestamp, "trace": rows}).encode())


class ExtractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "root"
        self.out = Path(self.tmp.name) / "out"
        self.day = "2025.02.26"
        self.airports = Path(self.tmp.name) / "airports.json"
        rows = [airport("KAAA", -100.0, 40.0), airport("KBBB", -94.0, 40.0)]
        self.airports.write_text(json.dumps({"rows": rows}), encoding="utf8")
        self.sha = hashlib.sha256(self.airports.read_bytes()).hexdigest()

    def flight_rows(self, flight="DAL123", grounded=True):
        rows = []
        if grounded:
            rows.append(row(-30, 40.0, -100.0, "ground", flight=None, source="adsb_icao"))
        for i in range(61):
            rows.append(row(i * 60, 40.0, -99.99 + i * 0.1, 500 if i in (0, 60) else 2500 if i in (1, 59) else 30000, flight=flight))
        if grounded:
            rows.append(row(3630, 40.0, -94.0, "ground", flight=None))
        return rows

    def install(self, traces, tamper=False):
        archive = w.archive
        folder = archive.day_dir(self.root, self.day)
        folder.mkdir(parents=True)
        parts = {}
        data = tar_part(traces)
        halves = {"aa": data[:len(data) // 2], "ab": data[len(data) // 2:]}
        for suffix, name in archive.part_names(self.day).items():
            (folder / name).write_bytes(halves[suffix])
            parts[name] = {"size": len(halves[suffix]) + (1 if tamper else 0), "sha256": hashlib.sha256(halves[suffix]).hexdigest()}
        (folder / "manifest.json").write_text(json.dumps({"day": self.day, "release": archive.tag(self.day), "parts": parts}), encoding="utf8")

    def run_extract(self, **kw):
        return w.extract(self.root, self.airports, self.day, self.out, airport_sha=kw.pop("airport_sha", self.sha))

    def test_extracts_a_leg_with_no_callsign_and_a_matcher_check(self):
        self.install([("./traces/aa/trace_full_abc123.json", plane(self.flight_rows())),
                      ("./traces/bb/trace_full_x.json", plane(self.flight_rows(flight="FDX9"), jet="A320")),
                      ("./traces/cc/trace_full_y.json", plane(self.flight_rows(), jet="C172"))])
        target = self.run_extract()
        text = target.read_text(encoding="utf8")
        legs = [json.loads(line) for line in text.splitlines()]
        self.assertEqual(len(legs), 1)
        leg = legs[0]
        self.assertEqual(set(leg), {"day", "release", "originIcao", "destinationIcao", "origin", "destination", "distanceKm",
                                    "firstAirMs", "lastAirMs", "grounded", "regions", "line"})
        self.assertTrue(leg["grounded"])
        self.assertEqual(leg["regions"], ["North America"])
        self.assertEqual(leg["release"], w.archive.tag(self.day))
        self.assertEqual(len(leg["line"]), 61)
        self.assertNotIn("DAL123", text)
        self.assertNotIn("abc123", text)
        check = json.loads((self.out / f"check-{self.day}.json").read_text(encoding="utf8"))
        self.assertEqual({k: check[k] for k in ("day", "release", "right", "wrong", "rejected", "noTruth")},
                         {"day": self.day, "release": w.archive.tag(self.day), "right": 2, "wrong": 0, "rejected": 0, "noTruth": 0})
        self.assertEqual(check["counts"]["legs"], 1)
        self.assertEqual(check["counts"]["callsign"], 1)
        self.assertEqual(check["counts"]["jets"], 2)
        self.assertEqual(check["counts"]["grounded"], 1)

    def test_a_leg_without_ground_rows_is_not_grounded(self):
        self.install([("./traces/aa/trace_full_abc123.json", plane(self.flight_rows(grounded=False)))])
        leg = json.loads(self.run_extract().read_text(encoding="utf8"))
        self.assertFalse(leg["grounded"])

    def test_a_corrupt_deflate_member_is_one_undecodable_trace_not_an_abort(self):
        bad = bytearray(plane(self.flight_rows()))
        for i in range(10, 16):
            bad[i] ^= 0xFF
        with self.assertRaises(zlib.error):
            gzip.decompress(bytes(bad))  # the failure the extractor must survive
        good = plane(self.flight_rows())
        traces = [(f"./traces/aa/trace_{i}.json", good) for i in range(150)] + [("./traces/zz/trace_bad.json", bytes(bad))]
        self.install(traces)
        self.run_extract()
        check = json.loads((self.out / f"check-{self.day}.json").read_text(encoding="utf8"))
        self.assertEqual((check["counts"]["undecodable"], check["counts"]["legs"]), (1, 150))

    def test_zero_legs_writes_nothing(self):
        self.install([("./traces/aa/trace_full_abc123.json", plane(self.flight_rows(flight="FDX9")))])
        with self.assertRaises(ValueError):
            self.run_extract()
        self.assertEqual(list(self.out.glob("*")) if self.out.exists() else [], [])

    def test_more_than_one_percent_undecodable_traces_writes_nothing(self):
        traces = [("./traces/aa/trace_full_abc123.json", plane(self.flight_rows()))]
        traces += [(f"./traces/zz/trace_{i}.json", b"not gzip") for i in range(2)]
        self.install(traces)
        with self.assertRaises(ValueError):
            self.run_extract()
        self.assertEqual(list(self.out.glob("*")) if self.out.exists() else [], [])

    def test_a_part_that_does_not_match_the_manifest_is_refused(self):
        self.install([("./traces/aa/trace_full_abc123.json", plane(self.flight_rows()))], tamper=True)
        with self.assertRaises(ValueError):
            self.run_extract()

    def test_the_airport_index_must_be_the_frozen_one(self):
        self.install([("./traces/aa/trace_full_abc123.json", plane(self.flight_rows()))])
        with self.assertRaises(ValueError):
            w.extract(self.root, self.airports, self.day, self.out)

    def test_another_airport_index_needs_the_explicit_option_and_warns(self):
        self.install([("./traces/aa/trace_full_abc123.json", plane(self.flight_rows()))])
        with contextlib.redirect_stderr(io.StringIO()) as err:
            target = self.run_extract(airport_sha="any")
        self.assertIn("WARNING", err.getvalue())
        self.assertTrue(target.exists())
        with self.assertRaises(ValueError):
            self.run_extract(airport_sha="0" * 64)

    def test_only_the_seven_archive_days_are_accepted(self):
        self.day = "2025.01.01"
        with self.assertRaises(ValueError):
            self.run_extract()
        self.assertEqual(sorted(w.DAYS), ["2025.02.26", "2025.03.26", "2025.05.21", "2025.07.30", "2025.08.27", "2025.09.24", "2025.11.26"])

    def test_the_manifest_must_describe_this_day_and_release(self):
        self.install([("./traces/aa/trace_full_abc123.json", plane(self.flight_rows()))])
        path = w.archive.day_dir(self.root, self.day) / "manifest.json"
        manifest = json.loads(path.read_text(encoding="utf8"))
        manifest["release"] = "v2025.02.26-planes-readsb-staging-0"
        path.write_text(json.dumps(manifest), encoding="utf8")
        with self.assertRaises(ValueError):
            self.run_extract()


if __name__ == "__main__":
    unittest.main()
