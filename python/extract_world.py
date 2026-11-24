"""Extract every qualifying world leg of one downloaded ADSB.lol archive day for the 250-2,000 km world confirmation (ODbL 1.0).
python -I -B python/extract_world.py --root <folder> --airports <airport index> [--out <folder>] <day>
Both parts of the day are verified against the day's manifest (written by adsb_archive.py), then read as one tar stream,
never extracted to disk. Writes legs-<day>.jsonl (one leg per line, no callsign, no aircraft id) and check-<day>.json (the
airport matcher check and the funnel counts). Prints counts only. The rules are in docs/method.md."""
import argparse
import collections
import gzip
import json
import math
import os
import re
import sys
import tarfile
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import adsb_archive as archive  # noqa: E402
import common as holdout  # noqa: E402
import extract_gate as base  # noqa: E402

OUT = HERE.parent / "work" / "legs-world"
Chain, sha256_of, line_of = base.Chain, base.sha256_of, base.line_of
JET_TYPES, OPERATORS, distance_km, AIRPORT_SHA = holdout.JET_TYPES, holdout.OPERATORS, holdout.distance_km, holdout.AIRPORT_SHA

DAYS = ("2025.02.26", "2025.03.26", "2025.05.21", "2025.07.30", "2025.08.27", "2025.09.24", "2025.11.26")
WORLD_OPERATORS = set("""
JIA GJS ASH AAY JZA MXY SCX ROU POE FLE VXP VIV EJU WMT ITY NOZ DLA SHT NSZ VOE TVF AEA TRA ANE BTI RUK EFW WUK PGT MAC FDB OMA ABY MEA
OMS MSR GFA SXS CYP SKY JNA ABL JJP SFJ IBX APJ AAR TWB JTA CAL MDA JJA SJX HKE TTW EVA APZ EOK CSZ XAX IGO AXB AKJ UBG BBC VJC MXD DAH
JAF LBT TAR TFL TUI SLI CAY AIQ AXM TGW TLM BTK TVJ NOK GIA BKP CTV JSA FFM CEB QLK TAM AZU LXP SKU ARG
""".split())
# First match wins, in the protocol's order.
REGION_PREFIXES = [
    ("K", "North America"), ("C", "North America"), ("PA", "North America"), ("PH", "North America"),
    ("M", "Central America/Caribbean"), ("T", "Central America/Caribbean"), ("S", "South America"), ("U", "Russia/CIS"),
    ("O", "Middle East"), ("D", "Africa"), ("F", "Africa"), ("G", "Africa"), ("H", "Africa"),
    ("E", "Europe"), ("L", "Europe"), ("B", "Europe"),
    ("VT", "Southeast Asia"), ("VV", "Southeast Asia"), ("VL", "Southeast Asia"), ("VD", "Southeast Asia"),
    ("VY", "Southeast Asia"), ("RP", "Southeast Asia"), ("W", "Southeast Asia"),
    ("VH", "East Asia"), ("VM", "East Asia"), ("Z", "East Asia"), ("R", "East Asia"),
    ("V", "South Asia"),
    ("Y", "Oceania/Pacific"), ("N", "Oceania/Pacific"), ("A", "Oceania/Pacific"), ("P", "Oceania/Pacific"),
]
CALLSIGN = re.compile(r"[A-Z]{3}[0-9][A-Z0-9]{0,4}")
MATCH_KM, MATCH_FT, AMBIGUITY = 30, 3000, 3
TRUTH_KM, TRUTH_ABOVE_FT = 8, 2000
SEGMENT_GAP_S, INNER_GAP_S, MIN_SAMPLES = 1200, 600, 5
FAST_KMH, FAST_PAIR_KM = 1300, 50
MIN_KM, MAX_KM, MIN_MIN = 250, 2000, 10
GROUND_WINDOW_S = 60
MAX_UNDECODABLE = 0.01


def numeric(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def candidates(rows):
    """Matcher candidates: IATA and ICAO codes, large or medium, scheduled service."""
    return [a for a in rows if a[0] and a[1] and a[7] <= 1 and a[10] == 1]


def cell_of(lon, lat):
    return ((math.floor(lon) + 180) % 360 - 180, math.floor(lat))


def build_grid(rows):
    """One-degree cells of (lon, lat, field elevation ft, icao); a blank elevation counts as 0."""
    grid = collections.defaultdict(list)
    for a in rows:
        grid[cell_of(a[5], a[6])].append((a[5], a[6], a[9] or 0, a[1]))
    return grid


def nearby(grid, lon, lat):
    """(distance km, elevation ft, icao) of every airport in the point's cell and its eight neighbours, nearest first."""
    cx, cy = cell_of(lon, lat)
    found = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for alon, alat, elevation, icao in grid.get(((cx + dx + 180) % 360 - 180, cy + dy), ()):
                found.append((distance_km([lon, lat], [alon, alat]), elevation, icao))
    return sorted(found)


def match_airport(grid, lon, lat, altitude_ft):
    """The nearest candidate when it is within 30 km, at most 3,000 ft above its field and the next one is three times as far."""
    near = nearby(grid, lon, lat)
    if not near:
        return None
    d1, elevation, icao = near[0]
    d2 = near[1][0] if len(near) > 1 else math.inf
    return icao if d1 <= MATCH_KM and altitude_ft - elevation <= MATCH_FT and d2 >= AMBIGUITY * d1 else None


def region_of(icao):
    return next((name for prefix, name in REGION_PREFIXES if icao.startswith(prefix)), "other")


def leg_regions(origin, destination):
    return sorted({region_of(origin), region_of(destination)})


def touches_rest_of_world(regions):
    return any(r not in ("North America", "Europe") for r in regions)


def segments(rows, timestamp):
    """Runs of consecutive adsb_icao samples with a numeric altitude, as (row index, time s, lat, lon, altitude ft, callsign).
    A ground row, or more than 1,200 s since the previous sample, ends a run. Rows of other sources are skipped."""
    out, current = [], []
    for i, r in enumerate(rows):
        if r[3] == "ground":
            if current:
                out.append(current)
            current = []
            continue
        if r[9] != "adsb_icao" or not numeric(r[3]):
            continue
        t = timestamp + r[0]
        if current and t - current[-1][1] > SEGMENT_GAP_S:
            out.append(current)
            current = []
        flight = r[8].get("flight") if isinstance(r[8], dict) else None
        current.append((i, t, r[1], r[2], r[3], flight.strip() if isinstance(flight, str) and flight.strip() else None))
    if current:
        out.append(current)
    return out


def reject_reason(seg):
    """None for a usable segment, else 'short', 'gap' or 'speed'."""
    if len(seg) < MIN_SAMPLES:
        return "short"
    for a, b in zip(seg, seg[1:]):
        dt = b[1] - a[1]
        if dt > INNER_GAP_S:
            return "gap"
        d = distance_km([a[3], a[2]], [b[3], b[2]])
        if d > FAST_PAIR_KM and (dt <= 0 or d / dt * 3600 > FAST_KMH):
            return "speed"
    return None


def callsign_of(seg):
    """The segment's one callsign when it has the airline shape and a listed operator, else None."""
    flights = {s[5] for s in seg if s[5]}
    if len(flights) != 1:
        return None
    flight = next(iter(flights))
    return flight if CALLSIGN.fullmatch(flight) and flight[:3] in OPERATORS | WORLD_OPERATORS else None


def distance_ok(km):
    return MIN_KM <= km < MAX_KM


def make_leg(seg, grid, where):
    """(leg fields, None) or (None, reason). `where` maps an ICAO code to (lon, lat)."""
    reason = reject_reason(seg)
    if reason:
        return None, reason
    if callsign_of(seg) is None:
        return None, "callsign"
    first, last = seg[0], seg[-1]
    origin = match_airport(grid, first[3], first[2], first[4])
    destination = match_airport(grid, last[3], last[2], last[4])
    if origin is None or destination is None:
        return None, "unmatched"
    if origin == destination:
        return None, "sameAirport"
    km = distance_km(where[origin], where[destination])
    if not distance_ok(km):
        return None, "distance"
    if last[1] - first[1] < MIN_MIN * 60:
        return None, "duration"
    return {"originIcao": origin, "destinationIcao": destination, "origin": list(where[origin]), "destination": list(where[destination]),
            "distanceKm": km, "firstAirMs": round(first[1] * 1000), "lastAirMs": round(last[1] * 1000)}, None


def ground_row(rows, index, direction, edge_t, timestamp):
    """The nearest ground row outward from rows[index] (direction -1 or 1) within 60 s of edge_t, else None.
    Rows of other sources may lie between."""
    i = index + direction
    while 0 <= i < len(rows):
        if abs(timestamp + rows[i][0] - edge_t) > GROUND_WINDOW_S:
            return None
        if rows[i][3] == "ground":
            return rows[i]
        i += direction
    return None


def check_end(inward, ground, match_grid, truth_grid):
    """One end of a grounded leg: 'noTruth', 'rejected', 'right' or 'wrong'. `inward` is the leg's samples from that end inward."""
    if ground is None or not numeric(ground[1]) or not numeric(ground[2]):
        return "noTruth"
    near = nearby(truth_grid, ground[2], ground[1])
    if not near or near[0][0] > TRUTH_KM:
        return "noTruth"
    _, elevation, true_icao = near[0]
    high = next((s for s in inward if s[4] - elevation >= TRUTH_ABOVE_FT), None)
    if high is None:
        return "rejected"
    got = match_airport(match_grid, high[3], high[2], high[4])
    return "rejected" if got is None else "right" if got == true_icao else "wrong"


def verify_manifest(root, day):
    """The day's two part paths, each checked against the manifest's size and SHA-256."""
    if day not in DAYS:
        raise ValueError(f"{day} is not one of the protocol's seven days")
    folder = archive.day_dir(root, day)
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf8"))
    names = list(archive.part_names(day).values())
    if manifest["day"] != day or manifest["release"] != archive.tag(day) or sorted(manifest["parts"]) != sorted(names):
        raise ValueError("The manifest does not describe this day's release and two parts")
    paths = []
    for name in names:
        path = folder / name
        pinned = manifest["parts"][name]
        if path.stat().st_size != pinned["size"] or sha256_of(path) != pinned["sha256"]:
            raise ValueError(f"{name} does not match the manifest")
        paths.append(path)
    return paths, manifest


def plane_rows(plane, tables, day, release):
    """(leg rows, matcher results, funnel counts) of one decoded trace. Raises on malformed rows."""
    match_grid, truth_grid, where = tables
    rows, timestamp = plane["trace"], plane["timestamp"]
    legs, checks, counts = [], collections.Counter(), collections.Counter()
    for seg in segments(rows, timestamp):
        counts["segments"] += 1
        leg, reason = make_leg(seg, match_grid, where)
        if reason:
            counts[reason] += 1
            continue
        first, last = seg[0], seg[-1]
        before = ground_row(rows, first[0], -1, first[1], timestamp)
        after = ground_row(rows, last[0], 1, last[1], timestamp)
        grounded = before is not None and after is not None
        if grounded:
            counts["grounded"] += 1
            checks[check_end(seg, before, match_grid, truth_grid)] += 1
            checks[check_end(seg[::-1], after, match_grid, truth_grid)] += 1
        regions = leg_regions(leg["originIcao"], leg["destinationIcao"])
        counts["legs"] += 1
        for r in regions:
            counts[f"region {r}"] += 1
        legs.append({"day": day, "release": release, **leg, "grounded": grounded, "regions": regions, "line": line_of(plane, leg)})
    return legs, checks, counts


def extract(root, airports_path, day, out_dir=OUT, airport_sha=AIRPORT_SHA):
    airports_data = Path(airports_path).read_bytes()
    holdout.check_airport_index(airports_data, airport_sha)
    index = json.loads(airports_data)["rows"]
    paths, manifest = verify_manifest(root, day)
    print(f"{day}: both parts match the manifest")

    match_rows = candidates(index)
    tables = (build_grid(match_rows), build_grid([a for a in index if a[0] and a[1]]), {a[1]: (a[5], a[6]) for a in match_rows})
    counts, checks = collections.Counter(), collections.Counter()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    target, check_target = out_dir / f"legs-{day}.jsonl", out_dir / f"check-{day}.json"
    temp, check_temp = (t.with_name(t.name + ".tmp") for t in (target, check_target))
    chain = Chain(paths)
    try:
        with temp.open("w", encoding="utf8", newline="\n") as out, tarfile.open(fileobj=chain, mode="r|") as tar:
            for member in tar:
                tar.members = []
                if not (member.isfile() and member.name.startswith("./traces/")):
                    continue
                counts["traces"] += 1
                raw = tar.extractfile(member).read()  # a broken tar raises here and aborts the run
                try:
                    plane = json.loads(gzip.decompress(raw))
                    if plane.get("t") not in JET_TYPES:
                        continue
                    legs, found, seen = plane_rows(plane, tables, day, manifest["release"])
                except (OSError, EOFError, zlib.error, ValueError, KeyError, IndexError, TypeError, AttributeError):
                    counts["undecodable"] += 1
                    continue
                counts["jets"] += 1
                counts.update(seen)
                checks.update(found)
                for leg in legs:
                    out.write(json.dumps(leg, separators=(",", ":")) + "\n")
        if not counts["legs"]:
            raise ValueError(f"No qualifying legs in {counts['traces']} traces: {dict(counts)}")
        if counts["undecodable"] > MAX_UNDECODABLE * counts["traces"]:
            raise ValueError(f"{counts['undecodable']} of {counts['traces']} traces are undecodable, over {MAX_UNDECODABLE:.0%}")
        check_temp.write_text(json.dumps({"day": day, "release": manifest["release"], "right": checks["right"], "wrong": checks["wrong"],
                                          "rejected": checks["rejected"], "noTruth": checks["noTruth"], "counts": dict(counts)}, indent=1),
                              encoding="utf8")
    except BaseException:
        temp.unlink(missing_ok=True)
        check_temp.unlink(missing_ok=True)
        raise
    finally:
        for f in chain.files:
            f.close()
    os.replace(check_temp, check_target)
    os.replace(temp, target)
    print(f"{day}: {dict(counts)}; matcher check {dict(checks)} -> {target}")
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--airports", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--airports-sha256", default=AIRPORT_SHA, help="SHA-256 the airport index must have (default: the pinned one); \"any\" accepts another index, with a warning")
    parser.add_argument("day")
    args = parser.parse_args()
    try:
        extract(args.root, args.airports, args.day, args.out, args.airports_sha256)
    except (tarfile.TarError, ValueError, OSError) as e:
        sys.exit(f"Aborted: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
