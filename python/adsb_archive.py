"""Download one complete ADSB.lol archive day (two .tar parts) from the GitHub releases of adsblol/globe_history_2025 (ODbL 1.0).
python -I -B python/adsb_archive.py --root <folder> --day <YYYY.MM.DD>
The root should lie outside this repository (a day is 2.6 to 3.7 GB). A partial `.part` file resumes with a byte range. A part
is renamed only when its size is exact, and a complete part is never touched. <root>/download-ledger.json counts every byte
received, failed attempts included. There is no retry loop: a network failure keeps the `.part`, records the bytes and exits
non-zero. GitHub lists a SHA-256 digest for the parts of four of the seven days, pinned below and checked before a part is
renamed (a mismatch deletes the part and exits non-zero). For the other three days no digest is listed, and the manifest marks
those hashes first-download. The cap is the total of all seven days, 22,345,266,688 bytes, plus a margin of 995,182,080 bytes for failed attempts."""
import argparse
import hashlib
import http.client
import json
import os
import shutil
import sys
from pathlib import Path
from urllib.request import Request, urlopen

BASE_URL = "https://github.com/adsblol/globe_history_2025/releases/download"
GIB = 1024**3
CAP_BYTES = 23_340_448_768
MIN_FREE_BYTES = 40 * GIB
CHUNK = 1024**2
FLUSH_EVERY = 64 * 1024**2
TIMEOUT_S = 90
# Sizes and digests read from `gh api repos/adsblol/globe_history_2025/releases/tags/<tag> -q '.assets[]|"\(.name) \(.size) \(.digest)"'`,
# 2026-11-23. A digest of None means GitHub lists none for that asset.
DAYS = {
    "2025.03.26": {"release": "prod-0", "sizes": {"aa": 2_000_000_000, "ab": 742_466_560},
                   "digests": {"aa": None, "ab": None}},
    "2025.07.30": {"release": "prod-0", "sizes": {"aa": 2_000_000_000, "ab": 1_592_929_280},
                   "digests": {"aa": "625a75f05131806f67937245a4c86c1044e27465e336a6369629ce98f350de82",
                               "ab": "d6e51b5d41fe920e932aa5d45d42aa93965a6ce0f9871e3e54e29d4ff1cc52c5"}},
    "2025.11.26": {"release": "staging-0", "sizes": {"aa": 2_000_000_000, "ab": 1_152_076_288},
                   "digests": {"aa": "225a0e15e08683fd0c828943b6650983c5b5e33b8e6b6ffbb621e24a45658b6d",
                               "ab": "872211b23dbb16a316223bc6504b79801fcf1f84867f4d528674da5d05b061cd"}},
    "2025.05.21": {"release": "prod-0", "sizes": {"aa": 2_000_000_000, "ab": 1_192_494_080},
                   "digests": {"aa": None, "ab": None}},
    "2025.08.27": {"release": "staging-0", "sizes": {"aa": 2_000_000_000, "ab": 1_660_482_560},
                   "digests": {"aa": "b4c3605ade49873a8b451081dc8e57a16c7feacdb121ef740c4d0ff5be3f48da",
                               "ab": "b14839d278de7d6294bc38c372ce72649ef279c9d54d3c15fa61ea87642dcf01"}},
    "2025.02.26": {"release": "prod-0", "sizes": {"aa": 2_000_000_000, "ab": 591_191_040},
                   "digests": {"aa": None, "ab": None}},
    "2025.09.24": {"release": "staging-0", "sizes": {"aa": 2_000_000_000, "ab": 1_413_626_880},
                   "digests": {"aa": "083dddfc7aa34b294b4056206fabe845d110f30bec3e4f14f606c3f852010478",
                               "ab": "8aac3b48ca0bbfc97fe5f6ddfc01098861a867600f058f91a8da1ff9f6642e27"}},
}
TOTAL_BYTES = 22_345_266_688
HASH_NOTE = ("hashSource publisher: the SHA-256 equals the digest GitHub lists for the asset and was checked before the part "
             "was renamed. hashSource first-download: GitHub lists no digest for the asset, so the SHA-256 is computed from "
             "the bytes of the first complete download and is not checked against a publisher digest.")


class Refused(Exception):
    pass


def tag(day):
    return f"v{day}-planes-readsb-{DAYS[day]['release']}"


def part_names(day):
    return {suffix: f"{tag(day)}.tar.{suffix}" for suffix in DAYS[day]["sizes"]}


def day_dir(root, day):
    return Path(root) / "2025" / tag(day)


def read_ledger(path):
    return json.loads(path.read_text(encoding="utf8")) if path.exists() else {}


def write_ledger(path, ledger):
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(ledger, indent=1), encoding="utf8")
    os.replace(temp, path)


def etag_path(part):
    return part.with_name(part.name + ".etag")


def resume_offset(part, expected):
    """Bytes of `part` that a resume may keep: all of them with a saved ETag, else none (the part restarts)."""
    if not part.exists():
        return 0
    size = part.stat().st_size
    if size > expected:
        raise Refused(f"{part.name} holds {size} bytes, more than the {expected} listed. Not touching it.")
    return size if size == expected or etag_path(part).exists() else 0


def fetch_part(url, part, expected, ledger_path, ledger, name):
    """Fills `part` to `expected` bytes. A resume sends the saved ETag in If-Range, so a changed source answers 200
    and the part restarts from byte 0. Counts every received byte in the ledger."""
    offset = resume_offset(part, expected)
    headers = {}
    if offset:
        headers = {"Range": f"bytes={offset}-", "If-Range": etag_path(part).read_text(encoding="utf8")}
    received = since_flush = 0
    try:
        with urlopen(Request(url, headers=headers), timeout=TIMEOUT_S) as response:
            length = response.headers.get("Content-Length")
            etag = response.headers.get("ETag")
            if offset and response.status == 206:
                if response.headers.get("Content-Range") != f"bytes {offset}-{expected - 1}/{expected}" or length != str(expected - offset):
                    raise Refused("The server's resume range or length is not the one requested. Kept the .part.")
                if not etag or etag != headers["If-Range"]:
                    raise Refused("The resumed response does not carry the saved ETag. Kept the .part.")
            elif response.status == 200:
                if length != str(expected):
                    raise Refused(f"The server announces {length} bytes, the listed size is {expected}")
                if sum(ledger.values()) + expected > CAP_BYTES:
                    raise Refused(f"A full restart of {name} would pass the cap of {CAP_BYTES}")
                if offset:
                    print(f"{name}: the source changed, restarting from byte 0")
                offset = 0
            else:
                raise Refused(f"The server answered {response.status}")
            with part.open("ab" if offset else "wb") as out:
                if not offset:  # the old bytes are gone, so only now may the ETag change
                    if etag:
                        etag_path(part).write_text(etag, encoding="utf8")
                    else:
                        etag_path(part).unlink(missing_ok=True)
                while received < expected - offset and (chunk := response.read(min(CHUNK, expected - offset - received))):
                    out.write(chunk)
                    received += len(chunk)
                    since_flush += len(chunk)
                    if since_flush >= FLUSH_EVERY:
                        write_ledger(ledger_path, {**ledger, name: ledger.get(name, 0) + received})
                        since_flush = 0
    finally:
        ledger[name] = ledger.get(name, 0) + received
        write_ledger(ledger_path, ledger)
    return received


def sha256_of(path):
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def download_day(root, day):
    """Returns the manifest path. Raises Refused for a guard, OSError or HTTPException for a network failure."""
    root = Path(root)
    folder = day_dir(root, day)
    names = part_names(day)
    sizes = DAYS[day]["sizes"]
    root.mkdir(parents=True, exist_ok=True)
    folder.mkdir(parents=True, exist_ok=True)
    ledger_path = root / "download-ledger.json"
    ledger = read_ledger(ledger_path)

    remaining = {}
    for suffix, name in names.items():
        final, part = folder / name, folder / f"{name}.part"
        if final.exists():
            if final.stat().st_size != sizes[suffix]:
                raise Refused(f"{name} exists with {final.stat().st_size} bytes, expected {sizes[suffix]}. Not touching it.")
            remaining[suffix] = 0
        else:
            remaining[suffix] = sizes[suffix] - resume_offset(part, sizes[suffix])
    need = sum(remaining.values())
    received = sum(ledger.values())
    if received + need > CAP_BYTES:
        raise Refused(f"{received} bytes already received and {need} more needed would pass the cap of {CAP_BYTES}")
    free = shutil.disk_usage(root).free
    if free - need < MIN_FREE_BYTES:
        raise Refused(f"{free} bytes free, {need} still to download, at least {MIN_FREE_BYTES} must remain free")

    digests = DAYS[day]["digests"]
    hashes = {}
    for suffix, name in names.items():
        final, part = folder / name, folder / f"{name}.part"
        if final.exists():
            print(f"{name}: complete, kept")
            done = final
        else:
            if part.exists() and part.stat().st_size == sizes[suffix]:
                print(f"{name}: complete .part found, verifying")
            else:
                got = fetch_part(f"{BASE_URL}/{tag(day)}/{name}", part, sizes[suffix], ledger_path, ledger, name)
                size = part.stat().st_size
                print(f"{name}: received {got} bytes, {size} of {sizes[suffix]} on disk")
                if size != sizes[suffix]:
                    raise OSError(f"{name} stopped at {size} of {sizes[suffix]} bytes. The .part is kept.")
            done = part
        hashes[suffix] = sha256_of(done)
        if digests[suffix] and hashes[suffix] != digests[suffix]:
            if done is final:
                raise Refused(f"{name} does not match the digest GitHub lists. The complete part is kept, untouched.")
            done.unlink()
            etag_path(part).unlink(missing_ok=True)
            raise Refused(f"{name} does not match the digest GitHub lists. The .part was deleted.")
        if done is part:
            os.replace(part, final)
            etag_path(part).unlink(missing_ok=True)

    manifest_path = folder / "manifest.json"
    if manifest_path.exists():
        kept = json.loads(manifest_path.read_text(encoding="utf8"))["parts"]
        if any(kept.get(names[s], {}).get("sha256") != h for s, h in hashes.items()):
            raise Refused(f"{manifest_path} does not match the parts on disk")
        print(f"{manifest_path}: kept")
        return manifest_path
    parts = {name: {"size": sizes[suffix], "sha256": hashes[suffix], "hashSource": "publisher" if digests[suffix] else "first-download"}
             for suffix, name in names.items()}
    manifest = {"day": day, "release": tag(day), "source": f"{BASE_URL}/{tag(day)}", "license": "ODbL-1.0, ADSB.lol",
                "hashNote": HASH_NOTE, "parts": parts}
    temp = manifest_path.with_name("manifest.json.tmp")
    temp.write_text(json.dumps(manifest, indent=1), encoding="utf8")
    os.replace(temp, manifest_path)
    return manifest_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--day", required=True, choices=sorted(DAYS))
    args = parser.parse_args()
    try:
        manifest = download_day(args.root, args.day)
    except Refused as e:
        sys.exit(f"Refused: {e}")
    except (OSError, http.client.HTTPException) as e:
        sys.exit(f"Network failure, partial bytes kept and counted: {e}")
    print(f"{args.day} complete. Total received {sum(read_ledger(args.root / 'download-ledger.json').values())} bytes. {manifest}")


assert sum(sum(d["sizes"].values()) for d in DAYS.values()) == TOTAL_BYTES

if __name__ == "__main__":
    main()
