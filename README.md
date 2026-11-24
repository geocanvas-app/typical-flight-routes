# Typical flight routes

One representative real flight track for each of 6,881 directed airport pairs, from ADS-B data, as open data under the
[Open Database License 1.0](data/ODbL-1.0.txt). The data is used by [GeoCanvas.Fly](https://geocanvas.fly). This repository
holds the released data, the reader, and the code that builds it from ADSB.lol's public archive.

Contains information from ADSB.lol, which is made available under the Open Database License (ODbL 1.0).

## What the data is

- A route is keyed by an ordered pair of ICAO airport codes, `ORIGIN-DESTINATION`. `EDDF-LFPG` is Frankfurt to Paris and
  `LFPG-EDDF` is a separate route.
- Its line is the medoid of at least 3 real flights of that pair on at least 2 different days: the real flight with the
  smallest summed mean distance to the others, not an average. It is simplified to at most 24 points and rounded to hundredths
  of a degree. The first and last points are the airports' coordinates.
- Distances of 250 to under 2,000 km (great circle between the two airports).
- Release 2026.11 has 6,881 routes, built from five 2025 archive days (see Days below).

## What it is not

- **Not a filed flight plan.** It is the track a real aircraft flew on a day in 2025. No airway, procedure or clearance data
  is involved.
- **Not worldwide.** It is mostly United States and Europe. The confirmation held 94.3 % of its held-out legs inside North
  America and Europe alone.
- **No claim for Africa, the Middle East, Southeast Asia or Russia/CIS.** The confirmation had too little evidence there, and
  routes with an end in those regions, or in an unlisted region, are not in the file.
- **No claim beyond 2,000 km.** Longer flights and pairs without a route are not in the file.
- **No claim of a flight-time gain.** Against a flat route stretch of 1.087 the library shows no pooled gain in flight-time
  error (details below). The evidence is for where the route runs, not for how long it takes.
- **No claim for other periods.** The days are all from 2025.
- **Not an average.** Each route is the simplified track of one real airline flight, chosen as the most typical for its
  airport pair. The file holds no aircraft identifiers, callsigns or times.

## Files

| Path | What | Licence |
| --- | --- | --- |
| `data/2026.11/typical-routes.json` | the released routes | ODbL 1.0 |
| `data/2026.11/README.txt` | the release's own notice, source releases and checksum | ODbL 1.0 |
| `data/ODbL-1.0.txt`, `data/NOTICE.md` | the licence text and the short notice | |
| `LICENSE`, `NOTICE` | Apache License 2.0 and the attribution notice that redistributions of the code must keep | Apache-2.0 |
| `src/decode.mjs`, `src/verify.mjs`, `src/cli.mjs` | reader and checksum verifier, no dependencies | Apache-2.0 |
| `src/lib/`, `src/build/` | build pipeline: medoid library, gate scoring, release (Node, depends on `geographiclib-geodesic`) | Apache-2.0 |
| `python/` | archive download and leg extraction (Python 3, standard library only) | Apache-2.0 |
| `docs/method.md` | the rules, leg definitions, scoring and decisions | Apache-2.0 |
| `test/` | tests and small synthetic fixtures. `test/fixtures/expected/original-decode-and-model.json` quotes two routes of the ODbL data | Apache-2.0, except those two quoted routes (ODbL 1.0) |

## Releases

| Version | Date | Size | SHA-256 of `typical-routes.json` | Routes |
| --- | --- | ---: | --- | ---: |
| [2026.11](data/2026.11/) | 2026-11 | 350,873 bytes | `83d2c851e56645824d4e5a13414e2e85b75c07fff835b7139c113096664ebac8` | 6,881 |

This repository is the free copy of the file. Check any copy: `npm run verify`, or `node src/cli.mjs verify <file> <sha256>`, or `sha256sum`. See [CHANGELOG.md](CHANGELOG.md).

## File format (`format: 2`)

`typical-routes.json` is one JSON object:

```json
{"format": 2, "version": "2026.11", "license": "ODbL-1.0", "licenseUrl": "...", "attribution": "...",
 "source": "https://www.adsb.lol/docs/open-data/historical", "builtFrom": ["v2025.03.26-planes-readsb-prod-0", "..."],
 "routes": {"CYEG-CYQQ": "<text>", "...": "..."}}
```

`builtFrom` lists the ADSB.lol release tags the routes were built from. Each value of `routes` is one route as a text of the
characters `A-Za-z0-9-_`. To decode it:

1. Read the text left to right as base-32 digits. The digit of a character is its index in
   `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_`, from 0 to 63.
2. Bit 5 of the index (32 or more) means another digit follows. The low 5 bits (index modulo 32) are the digit's value. A
   number ends at the first character with index below 32.
3. A number's digits are least significant first: `value = d0 + 32 * d1 + 1024 * d2 + ...`. At most 7 digits.
4. Undo the zigzag: an even value `v` is `v / 2`, an odd value is `-(v + 1) / 2`. The results are integers in hundredths of a
   degree.
5. The integers come in pairs. The first pair is the first point's longitude and latitude. Every later pair is the
   change in longitude and latitude from the point before. Add them up, and wrap each longitude into [-180, 180) in
   hundredths (`((v + 18000) mod 36000) - 18000`), so a route can cross the antimeridian. Divide by 100 for degrees.
6. A text that ends inside a number, or holds another character, is invalid. A lone coordinate (odd count), fewer than two points, or a latitude beyond +-90 is invalid.

Worked example, the start of `EDDF-LFPG`, `w1B24JHjB...`: `w` is index 48 (digit 16, continues), `1` is 53 (digit 21,
continues), `B` is 1 (digit 1, ends). The value is 16 + 21 x 32 + 1 x 1024 = 1712, zigzag 856, so longitude 8.56. `24J`
gives 5003, so latitude 50.03: Frankfurt, (8.56, 50.03).

The reference reader is [`src/decode.mjs`](src/decode.mjs) (about 75 lines, no dependencies):

```js
import {readFileSync} from 'node:fs';
import {decodeFile} from './src/decode.mjs';
const routes = decodeFile(JSON.parse(readFileSync('data/2026.11/typical-routes.json', 'utf8')));
routes['EDDF-LFPG'];   // [[8.56, 50.03], [8.52, 49.85], ..., [2.55, 49.01]]
```

Command line: `node src/cli.mjs decode data/2026.11/typical-routes.json EDDF-LFPG`.

The file has no checksum inside. A text cut at a point boundary still decodes to a valid shorter line, so check the file's
SHA-256.

## Method in brief

Full rules: [docs/method.md](docs/method.md).

1. **Legs from the archive.** From ADSB.lol's daily archive, passenger jets of a listed type on one airline callsign. A leg
   runs from a first to a last airborne ADS-B sample, kept as one point per 60 s. Both ends must match a scheduled large or
   medium airport of an airport index (nearest within 30 km, at most 3,000 ft above the field, the next nearest at least three
   times as far). The legs keep no callsign and no aircraft identity.
2. **Library.** For each directional ICAO pair, the medoid of its legs (at least 3 legs on at least 2 days), simplified to at
   most 24 points.
3. **Gates.** The library is built from build days only and scored on legs of other, held-out days, against the great circle.
   The first gate's rules were fixed before any of its days were downloaded. The world confirmation's rules were fixed before
   its two held-out days were downloaded, after count-only runs on two of its build days chose its airport matcher and its
   added operators (see the World confirmation section). Each gate ran once.
4. **Release.** The routes the confirmation could not judge are dropped and the rest written as compact text.

### Days

| Day | Release tag | First gate | World confirmation |
| --- | --- | --- | --- |
| 2025.02.26 | `v2025.02.26-planes-readsb-prod-0` | | holdout |
| 2025.03.26 | `v2025.03.26-planes-readsb-prod-0` | build | build |
| 2025.05.21 | `v2025.05.21-planes-readsb-prod-0` | holdout | build |
| 2025.07.30 | `v2025.07.30-planes-readsb-prod-0` | build | build |
| 2025.08.27 | `v2025.08.27-planes-readsb-staging-0` | holdout | build |
| 2025.09.24 | `v2025.09.24-planes-readsb-staging-0` | | holdout |
| 2025.11.26 | `v2025.11.26-planes-readsb-staging-0` | build | build |

**Release 2026.11 is built from the five world-confirmation build days:** 2025.03.26, 2025.05.21, 2025.07.30, 2025.08.27 and
2025.11.26. Those five days gave 113,327 legs on 10,081 directed airport pairs. The library has routes for 6,978 of those
pairs, of which 6,881 remain after the regions that could not be judged are removed. The two holdout days (2025.02.26 and
2025.09.24) were never used to build it. Releases are from GitHub release assets of
[`adsblol/globe_history_2025`](https://github.com/adsblol/globe_history_2025/releases), named
`<tag>.tar.aa` and `<tag>.tar.ab` (the two parts of one tar).

### First gate: three build days, two holdout days

Build 2025.03.26, 2025.07.30, 2025.11.26. Holdout 2025.05.21 and 2025.08.27 (11,895 holdout legs). All distances from 60 km
to under 20,000 km, ground report to ground report legs. Medians over covered legs.

| Measure | Library | Great circle / legacy model | Rule | Result |
| --- | ---: | ---: | --- | --- |
| Coverage (10,019 of 11,895 holdout legs) | 84.23 % | n/a | at least 50 % | pass |
| Sideways error | 9.02 km | 40.72 km | at most half | pass |
| Length error | 2.16 % | 7.93 % | at most half | pass |
| Absolute time error | 4.85 min | 7.13 min | no worse | pass |
| Library size, zipped | 53,947 bytes | n/a | at most 3 MiB | pass |

Go. The library had 1,507 airport pairs from 2,967 build pairs and 19,338 build legs. This was a pooled result. By distance
the benefit was not uniform: beyond about 2,500 km the library did not reduce the sideways error, and its time error was
worse than the legacy model's (2500+ km: 18.01 against 14.87 min). The holdout has 2,427 distinct airport pairs and 1,358
(56.0 %) were in the library, so coverage is weighted by busy pairs. That is why the claim was narrowed to 250 to 2,000 km and
tested again on fresh days.

### World confirmation: 250 to 2,000 km on two fresh days

Library built from the five build days, scored on 2025.02.26 and 2025.09.24 (41,629 legs, 6,458 scored pairs). The leg rule
here needs no ground report, so it covers Asia, and an airport matcher stands in for it. On held-out flights with ground
reports the matcher named the wrong airport for 78 of 12,640 judged ends (0.62 %) and rejected another 6,578 of the 19,218 ends
tested. It could not be measured where ground reports are missing, including South Asia and Southeast Asia.

| Group | Legs | Scored pairs | Coverage | Sideways library / great circle (km) | Length library / great circle (%) | Class |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Pooled 250-2,000 km | 41,629 | 6,458 | 95.7 % | 8.07 / 39.64 | 2.33 / 8.75 | confirmed |
| 250-500 km | 8,289 | 947 | 96.8 % | 6.06 / 24.54 | 4.21 / 15.53 | confirmed |
| 500-1,000 km | 17,018 | 2,371 | 96.6 % | 7.11 / 35.97 | 2.59 / 9.80 | confirmed |
| 1,000-1,500 km | 10,202 | 1,866 | 95.2 % | 10.39 / 52.28 | 1.84 / 6.79 | confirmed |
| 1,500-2,000 km | 6,120 | 1,274 | 92.7 % | 13.64 / 66.25 | 1.43 / 5.58 | confirmed |

Go, confirmed range 250-2,000 km, `worldConfirmed: true` (see the limits below). The library had routes for 6,978 of the 10,081 directed airport pairs and was 234,112 bytes
zipped.

**What the supported claim is.** Pooled over two held-out 2025 days, for matched flights on library pairs, the library has about
four to five times less sideways error than the great circle (4.05 to 5.06 times by band) and about a quarter of the length
error, in all four bands. Europe at 250-500 km is lower, at 2.9 times. It does not say how long a flight takes.

**Limits found by independent review of the same data, which do not change the verdict:**

- **`worldConfirmed` is narrower than its name.** 94.3 % of holdout legs touch only North America and Europe, and Oceania
  supplies 57 % of the scored rest-of-world legs. Rest of world has too little evidence at 1,500-2,000 km (58 legs), and without
  Oceania too little at 1,000-1,500 km (15 legs).
- **Four confirmed regions are thin.** Removing their top three pairs makes Central America, South America, East Asia and South
  Asia insufficient. East Asia has 16 directed but only 9 undirected pairs. Central America is insufficient on each holdout
  day alone, and South America and South Asia on February alone.
- **The airport matcher is unmeasured where it matters most.** South Asia and Southeast Asia have no grounded holdout legs, and
  East Asia has 7.
- **Coverage depends on what is counted.** It is 95.7 % of matched legs but 81.5 % of directed holdout pairs (6,458 of
  7,920). Flights receivers did not see, or that failed the filters, are outside both numbers.
- **The first and last 10 % of each route are not scored.** At 250-500 km, 46 % of scored points are within 100 km of an end
  airport and 94 % within 200 km, so that band says less about the cruise.
- **No pooled flight-time gain over a flat stretch is shown.** On grounded legs the library's median time error is 4.59 min, the
  legacy model's 7.25 and a flat 1.087 stretch's 4.65. Library minus flat is -0.07 min pooled (95 % interval -0.27 to +0.15):
  better at 250-500 km (-0.49 [-0.89, -0.09]) and worse at 1,000-1,500 km (+0.55 [+0.13, +1.09]) and 1,500-2,000 km
  (+0.91 [+0.28, +1.60]). The calm-wind model given each flight's true length still leaves a 3.56 min median error, so better
  route length alone cannot remove most of the time error. In the rest of world the library's median time error is higher
  than the legacy model's (5.24 against 4.82 min), but the difference is unresolved (+0.43 [-1.26, +1.79]); without Oceania the
  library is lower (2.74 against 6.26 min, 120 legs). This check does not separate speed, wind or other causes.
- The 10-minute airborne gap filter leaves no ocean crossings, so ocean routes are unmeasured.
- Five build days and two holdout days, all 2025.

### Regional confidence

Class of each region's held-out group under the confirmation's rules. "Confirmed" needs at least 100 scored legs on at least
10 pairs and all four group rules to pass. The file has no routes for the four regions that lack evidence.

| Region | Legs | Scored pairs | Coverage | Sideways lib / gc (km) | Length lib / gc (%) | Class and what it covers |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| North America | 24,074 | 3,352 | 97.5 % | 7.92 / 42.95 | 2.30 / 8.47 | confirmed, robust in all four bands |
| Europe | 15,371 | 2,956 | 92.6 % | 8.98 / 37.34 | 2.36 / 8.99 | confirmed, robust in all four bands |
| Oceania/Pacific | 1,321 | 70 | 98.9 % | 3.65 / 28.94 | 2.29 / 8.46 | confirmed, Australia and New Zealand only, up to 1,500 km |
| South America | 293 | 23 | 96.2 % | 4.81 / 24.42 | 1.72 / 18.23 | confirmed, Brazil only, thin |
| East Asia | 214 | 16 | 93.9 % | 6.06 / 42.27 | 3.14 / 25.89 | confirmed, Japan and a few Korean routes, no China, thin |
| South Asia | 173 | 17 | 100 % | 5.61 / 33.12 | 4.56 / 13.68 | confirmed, 7 airports in western and southern India, thin |
| Central America/Caribbean | 144 | 33 | 92.4 % | 9.04 / 30.29 | 2.24 / 10.69 | confirmed, mainly Mexico and US-Mexico, thin |
| Africa | 87 | 28 | 72.4 % | 7.25 / 31.84 | 2.37 / 5.13 | insufficient evidence, not in the file |
| Southeast Asia | 70 | 7 | 92.9 % | 12.65 / 18.63 | 8.42 / 34.14 | insufficient evidence, not in the file |
| Middle East | 58 | 9 | 96.6 % | 4.48 / 16.20 | 6.88 / 14.37 | insufficient evidence, not in the file |
| Russia/CIS | 0 | 0 | n/a | n/a | n/a | insufficient evidence, not in the file |

The file keeps every route of a confirmed region, including distances at which that region alone had too little evidence (for
example 4 Oceania routes over 1,500 km). 6,699 of the 6,881 routes (97.4 %) have both ends in North America or Europe.

Beyond North America and Europe the claim holds only narrowly: for Japan with a few Korean routes and for Brazil (only 250-500 km
has enough evidence alone), for western and southern India (only 500-1,000 km), and for Mexico with US-Mexico routes (no band
has enough evidence alone). The rest-of-world group as a whole (2,360 legs, 203 pairs) was confirmed, and 57 % of its scored
legs are Oceania. "Insufficient evidence" is a shortfall, not evidence for or against a region.

## Reproduce

The raw
archive is not in this repository and is not copied here. To reproduce, download it from ADSB.lol yourself. The seven days
are 22,345,266,688 bytes in all (about 22 GB, the sizes are in the day table of [docs/method.md](docs/method.md)). The downloader also refuses to start unless 40 GiB would remain free afterwards. The
extraction reads every day's tar once and takes hours. Keep the download folder outside this repository.

Needs Node 22 or later (`npm ci`, one dependency: `geographiclib-geodesic`) and Python 3, standard library only. Tested
with Node 24 and Python 3.13. Run Python as `python -I -B`.

**Inputs.** Besides the archive, the extractors need an airport index. Build your own from [OurAirports](https://ourairports.com/data/)
(public domain, thanks to its maintainers and contributors); the row layout the extractors read is in the "Airport index" table of
[docs/method.md](docs/method.md). The released data used one specific index (9,045 airports, SHA-256
`973f43a39113ef151d175b5222ebd4ecc1816e38c601f6053ea520bb41133144`), which is not published here. By default the extractors
refuse any other file. Pass `--airports-sha256 any` to accept yours; a warning is printed. **An index built from a different
OurAirports snapshot, or with other choices, gives different legs and routes than the released ones, so the checksums below
will not match.**

```sh
# 1. Download the seven days (resumable; checks GitHub's digests where listed; writes manifest.json per day)
for day in 2025.02.26 2025.03.26 2025.05.21 2025.07.30 2025.08.27 2025.09.24 2025.11.26; do
  python -I -B python/adsb_archive.py --root /path/to/archive --day $day
done

# 2. Extract the legs of each day (verifies the parts against the manifest, streams the tar, writes work/legs-world/)
for day in 2025.02.26 2025.03.26 2025.05.21 2025.07.30 2025.08.27 2025.09.24 2025.11.26; do
  python -I -B python/extract_world.py --root /path/to/archive --airports /path/to/airports-index.json --airports-sha256 any $day
done

# 3. Build the library and score it (refuses to run twice in one folder)
node src/build/world-gate.mjs work/legs-world work/world-out

# 4. Write the release
node src/build/release.mjs 2026.11 work/world-out/index.json work/release 2e3d2e7bea14dbbc05ba2090cec0e732b265d9a4200f582ad25dad684307f72c
sha256sum work/release/typical-routes.json
```

**Expected output**, for the index the release used. `work/world-out/index.json` has SHA-256
`2e3d2e7bea14dbbc05ba2090cec0e732b265d9a4200f582ad25dad684307f72c` (6,978 routes), the world gate's `result.json` has SHA-256
`94166bd751e996cac6dd9198857bfbb0f404cea3d8905978f0e51f3307993c5a`, and
`work/release/typical-routes.json` has SHA-256 `83d2c851e56645824d4e5a13414e2e85b75c07fff835b7139c113096664ebac8`
(350,873 bytes, 6,881 routes), byte for byte the file in `data/2026.11/`. Step 4 checks the gate index's SHA-256 when given.
Parts of days with no digest listed by GitHub are pinned by their first download, so a differing part is detected only
against your own `manifest.json`; if the extracted legs differ, compare the part sizes with the day table first.

The first gate reproduces the same way with `python/extract_gate.py` on its five days (2025.03.26, 2025.07.30, 2025.11.26,
2025.05.21, 2025.08.27) and `node src/build/gate.mjs work/legs-gate work/gate-out`. Its original run wrote an `index.json`
with SHA-256 `faae7fad826ac89026c3725e22491087a60a5e00d39a02d9b1d5764ffa41a58e` and a `result.json` with
`3f3fe95d5f3a2e9e9949e0193509bd9aa0e9983ab71e0f63e4a6a3314f39a854`.

### What was verified of this code

The pipeline here is a port of the code that produced release 2026.11, with the same logic, without the application it was
written inside. The checksums above are those of the original runs. Checked here:

- The release step run on the original library `index.json` writes a `typical-routes.json` and `README.txt` byte-identical to
  the files in `data/2026.11/`.
- On small synthetic inputs (made-up traces between real airports, never archive data), the Python extractors write the same
  legs as the originals, byte for byte, and both gates write the same `index.json` and `result.json`. The fixtures in
  `test/fixtures/` are those inputs and the original outputs, and `npm test` checks the ported gates and the model against them.
- The decoder decodes all 6,881 routes of the release and agrees with the original reader on the first and last route and on a
  hash of the whole decode.
- The ported gates were run on the real leg files that the original extractors wrote from the archive days. The world gate wrote
  an `index.json` with SHA-256 `2e3d2e7b...` and a `result.json` with SHA-256 `94166bd7...`, and the first gate an `index.json`
  with `faae7fad...` and a `result.json` with `3f3fe95d...`: all four are the published values, and the files are byte-identical
  to the original runs'.
- The extractors were not re-run on the real archive days (that takes hours), only on the synthetic inputs above.

```sh
npm test                 # decoder, library, rules, release, parity with the original outputs
npm run test:python      # extractors on synthetic inputs
```

## Attribution and licences

- **Data (`data/`)**: Open Database License 1.0. The file is a Derivative Database of ADSB.lol's historical data, offered here
  whole under section 4.6 of the licence. Keep the notice
  "Contains information from ADSB.lol, which is made available under the Open Database License (ODbL 1.0)." and share any
  database you derive from it under the ODbL. See [data/NOTICE.md](data/NOTICE.md) and [data/ODbL-1.0.txt](data/ODbL-1.0.txt).
  ADSB.lol's page states the licence ("ODbL 1.0, use it freely, just keep it open") and no particular attribution wording.
- **Code, tests and documentation (everything outside `data/`)**: Apache License 2.0, see [LICENSE](LICENSE). Redistributing the code requires keeping the
  [NOTICE](NOTICE) file (Apache section 4(d)). The one exception is the two routes quoted in
  `test/fixtures/expected/original-decode-and-model.json` (and the example in this README), which are ODbL data.
- The ADSB.lol archive itself is theirs, under the ODbL, and is not copied here. Airport locations come from the airport
  index, built from [OurAirports](https://ourairports.com/data/) (public domain).
- Used by [GeoCanvas.Fly](https://geocanvas.fly). Its open-data page: https://geocanvas.fly/open-data
