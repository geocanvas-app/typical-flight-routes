"""Extract every qualifying jet leg of one downloaded ADSB.lol archive day for the first gate (ODbL 1.0).
python -I -B python/extract_gate.py --root <folder> --airports <airport index> [--out <folder>] <day>
Both parts of the day are verified against the day's manifest (written by adsb_archive.py), then read as one tar stream,
never extracted to disk. The leg filters are `common.legs()` (ground report to ground report, 60 to under 20,000 km).
Writes legs-<day>.jsonl, one leg per line, with no callsign. Prints counts only."""
import argparse
import collections
import gzip
import hashlib
import json
import os
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import adsb_archive as archive  # noqa: E402
import common as holdout  # noqa: E402

OUT = HERE.parent / "work" / "legs-gate"
EUROPE = set("AT BE BG CH CY CZ DE DK EE ES FI FR GB GR HR HU IE IS IT LT LU LV MT NL NO PL PT RO SE SI SK".split())
POINT_EVERY_MS = 60_000
MAX_UNDECODABLE = 0.01


class Chain:
    """The parts as one readable stream."""

    def __init__(self, paths):
        self.files = [p.open("rb") for p in paths]

    def read(self, n=-1):
        out = b""
        while self.files and (n < 0 or len(out) < n):
            chunk = self.files[0].read(-1 if n < 0 else n - len(out))
            if not chunk:
                self.files.pop(0).close()
            out += chunk
        return out


def sha256_of(path):
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1024**2):
            digest.update(chunk)
    return digest.hexdigest()


def region(country, origin, destination):
    o, d = country[origin], country[destination]
    return "US" if o == d == "US" else "Europe" if o in EUROPE and d in EUROPE else "other"


def line_of(plane, leg):
    """One measured point per 60 s, plus the last, between the leg's first and last measured airborne samples."""
    points, kept = [], None
    for r in plane["trace"]:
        t = round((plane["timestamp"] + r[0]) * 1000)
        if t < leg["firstAirMs"] or t > leg["lastAirMs"] or r[9] != "adsb_icao" or not isinstance(r[3], (int, float)):
            continue
        if kept is None or t - kept >= POINT_EVERY_MS or t == leg["lastAirMs"]:
            points.append([round(r[2], 5), round(r[1], 5)])
            kept = t
    return points


def extract(root, airports_path, day, out_dir=OUT, airport_sha=None):
    airports_data = Path(airports_path).read_bytes()
    holdout.check_airport_index(airports_data, airport_sha)
    rows = json.loads(airports_data)["rows"]
    airports = [a for a in rows if a[0] and a[1]]
    icao_of = collections.defaultdict(set)
    country = {}
    for a in airports:
        icao_of[(a[0], a[5], a[6])].add(a[1])
        country[a[1]] = a[4]

    folder = archive.day_dir(root, day)
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf8"))
    names = list(archive.part_names(day).values())
    if manifest["day"] != day or sorted(manifest["parts"]) != sorted(names):
        raise ValueError("The manifest does not describe this day's two parts")
    paths = []
    for name in names:
        path = folder / name
        pinned = manifest["parts"][name]
        if path.stat().st_size != pinned["size"] or sha256_of(path) !=pinned["sha256"]:
            raise ValueError(f"{name} does not match the manifest")
        paths.append(path)
    print(f"{day}: both parts match the manifest")

    counts = collections.Counter()
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"legs-{day}.jsonl"
    temp = target.with_name(target.name + ".tmp")
    try:
        write_legs(temp, paths, airports, icao_of, country, manifest, day, counts)
        if not counts["legs"]:
            raise ValueError(f"No qualifying legs in {counts['traces']} traces: {dict(counts)}")
        if counts["undecodable"] > MAX_UNDECODABLE * counts["traces"]:
            raise ValueError(f"{counts['undecodable']} of {counts['traces']} traces are undecodable, over {MAX_UNDECODABLE:.0%}")
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    os.replace(temp, target)
    print(f"{day}: {dict(counts)} -> {target}")
    return target


def write_legs(temp, paths, airports, icao_of, country, manifest, day, counts):
    with temp.open("w", encoding="utf8", newline="\n") as out, tarfile.open(fileobj=Chain(paths), mode="r|") as tar:
        for member in tar:
            tar.members = []
            if not (member.isfile() and member.name.startswith("./traces/")):
                continue
            counts["traces"] += 1
            raw = tar.extractfile(member).read()  # a broken tar raises here and aborts the run
            try:
                plane = json.loads(gzip.decompress(raw))
                if plane.get("t") not in holdout.JET_TYPES:
                    continue
                found = list(holdout.legs(plane, airports))
            except (OSError, EOFError, ValueError, KeyError, IndexError, TypeError, AttributeError):
                counts["undecodable"] += 1
                continue
            counts["jets"] += 1
            for leg in found:
                iata_o, iata_d = leg["route"].split("-")
                o = icao_of.get((iata_o, *leg["origin"]), set())
                d = icao_of.get((iata_d, *leg["destination"]), set())
                if len(o) != 1 or len(d) != 1:
                    counts["unresolved"] += 1
                    continue
                origin, destination = next(iter(o)), next(iter(d))
                line = line_of(plane, leg)
                counts["legs"] += 1
                counts[region(country, origin, destination)] += 1
                out.write(json.dumps({
                    "day": day, "release": manifest["release"], "originIcao": origin, "destinationIcao": destination,
                    "origin": leg["origin"], "destination": leg["destination"], "distanceKm": leg["distanceKm"],
                    "firstAirMs": leg["firstAirMs"], "lastAirMs": leg["lastAirMs"], "region": region(country, origin, destination),
                    "line": line}, separators=(",", ":")) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--airports", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--airports-sha256", default=None, help="SHA-256 the airport index must have (default: the pinned one); \"any\" accepts another index, with a warning")
    parser.add_argument("day")
    args = parser.parse_args()
    try:
        extract(args.root, args.airports, args.day, args.out, args.airports_sha256)
    except (tarfile.TarError, ValueError, OSError) as e:
        sys.exit(f"Aborted: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
