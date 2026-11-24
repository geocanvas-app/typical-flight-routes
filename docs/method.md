# Method

The first gate's rules were fixed before any of its days were downloaded. The world confirmation's rules were fixed before its
two held-out days were downloaded, and after the count-only runs described under the world confirmation. Each gate was run
once, and its thresholds, filters, days and operator lists were not tuned afterwards. The code in `python/` and `src/` implements
exactly these rules.

## Source data

ADSB.lol historical data, ODbL 1.0, published as GitHub releases of
[`adsblol/globe_history_2025`](https://github.com/adsblol/globe_history_2025). ADSB.lol's page on the data is
https://www.adsb.lol/docs/open-data/historical. A day is one release, split into two parts (`.tar.aa`, `.tar.ab`) that
concatenate to one tar of per-aircraft trace files.

| Day | Release tag | Used in the first gate | Used in the world confirmation | `.tar.aa` bytes | `.tar.ab` bytes | Digest listed by GitHub when read |
| --- | --- | --- | --- | ---: | ---: | --- |
| 2025.02.26 | `v2025.02.26-planes-readsb-prod-0` | | holdout | 2,000,000,000 | 591,191,040 | none |
| 2025.03.26 | `v2025.03.26-planes-readsb-prod-0` | build | build | 2,000,000,000 | 742,466,560 | none |
| 2025.05.21 | `v2025.05.21-planes-readsb-prod-0` | holdout | build | 2,000,000,000 | 1,192,494,080 | none |
| 2025.07.30 | `v2025.07.30-planes-readsb-prod-0` | build | build | 2,000,000,000 | 1,592,929,280 | yes |
| 2025.08.27 | `v2025.08.27-planes-readsb-staging-0` | holdout | build | 2,000,000,000 | 1,660,482,560 | yes |
| 2025.09.24 | `v2025.09.24-planes-readsb-staging-0` | | holdout | 2,000,000,000 | 1,413,626,880 | yes |
| 2025.11.26 | `v2025.11.26-planes-readsb-staging-0` | build | build | 2,000,000,000 | 1,152,076,288 | yes |

All seven days together are 22,345,266,688 bytes. The sizes and the digests that exist are pinned in
`python/adsb_archive.py`, which checks a listed digest before it keeps a part. For the three days without a listed digest
(2025.02.26, 2025.03.26, 2025.05.21) the downloader records the SHA-256 of the first complete download in the day's
`manifest.json`, and the extractors verify every later read against it. Such a hash proves the copy did not change, not that
it equals the publisher's file.

The days were chosen from ADSB.lol's preferred-release list (`PREFERRED_RELEASES.txt` in the same repository, SHA-256 of the
version read `3414529a55b3521554e73643a1cebe10617358bd793c989c747f19f114c3079d`). All seven are Wednesdays.

## Library: the typical route of an airport pair

For each directional ICAO pair, `typicalRoute` (`src/lib/library.mjs`) takes all that pair's build-day legs:

1. A pair needs at least 3 legs on at least 2 days, else it has no route.
2. Each leg's measured line is resampled to 33 points evenly spaced along its length.
3. The medoid is chosen: the real leg with the smallest summed mean point-to-point geodesic distance to all the other legs. It
   is a real flight, not an average.
4. The medoid's measured line (one point per 60 s) is simplified with Douglas-Peucker in a local equirectangular frame
   scaled by the line's mean latitude, antimeridian-safe, starting at a 5 km tolerance and doubling it until at most 24
   points remain.
5. The first and last points are replaced by the two airports' coordinates.
6. Coordinates are rounded to hundredths of a degree and written with `encodeRoute` and `encodeRouteText`.

## Inputs

**Airport index.** A JSON object `{"rows": [...]}` (the released one also has `"format": 2`, which the extractors ignore). Each row is
an array read by position:

| Index | Field | Read as |
| ---: | --- | --- |
| 0 | `iata` | IATA code, `""` when none. A row needs both an IATA and an ICAO code to be used at all |
| 1 | `icao` | ICAO code, the key of the output routes |
| 2, 3 | `name`, `municipality` | not read |
| 4 | `country` | two-letter ISO country code. The first gate calls a leg `US` when both ends are `US` and `Europe` when both are in its European list (`EUROPE` in `python/extract_gate.py`) |
| 5, 6 | `lon`, `lat` | degrees, WGS84 |
| 7 | `size` | 0 large, 1 medium, higher smaller. The world matcher uses rows with `size <= 1` |
| 8 | `timezone` | not read |
| 9 | `elevationFt` | field elevation in feet, `null` counts as 0 |
| 10 | `scheduled` | 1 for scheduled passenger service, else 0. The world matcher uses rows with 1 |

The released data used a table of 9,045 airports built from [OurAirports](https://ourairports.com/data/) (public domain): `size`
from the airport type (large, medium, small ...), `scheduled` from `scheduled_service`, `elevationFt` from `elevation_ft`. The
extractors by default accept only the file with SHA-256 `973f43a39113ef151d175b5222ebd4ecc1816e38c601f6053ea520bb41133144`
(`AIRPORT_SHA` in `python/common.py`). That file is not published here. To use an index you built yourself, pass
`--airports-sha256 any`; a warning is printed. An index from a different OurAirports snapshot, or built with other choices,
gives different legs and routes than the released ones.

## First gate: build on three days, test on two

Question: does a library built from some days predict the routes flown on other days?

**Leg (first gate), `python/common.py` `legs()`.** A jet of a listed type flying one passenger-operator callsign
(`[A-Z]{3}[0-9][A-Z0-9]{0,4}`, operator in the fixed list in `common.py`) from a ground report to a ground report at least
10 min later, with at least 3 airborne `adsb_icao` samples with numeric altitude, the first and last within 60 s of the ground
reports, no airborne gap over 10 min, and both ends within 5 km of an airport with an IATA and an ICAO code. Great-circle
distance from 60 km up to but not including 20,000 km. Every qualifying leg is kept, with no cap per distance band or
airframe. Airports are resolved to ICAO by IATA code plus exact coordinates in the airport index; a leg that does not resolve
to exactly one ICAO at each end is dropped. The leg's measured line is its `adsb_icao` points with numeric altitude between
its first and last airborne sample, one point per 60 s plus the last. Legs are written without callsign or aircraft
identity.

**Days.** Build: 2025.03.26, 2025.07.30, 2025.11.26. Holdout: 2025.05.21, 2025.08.27. The library never saw a holdout day.

**Scoring (`src/build/gate.mjs`).** Coverage is the share of holdout legs whose pair has a library route. Every other
measure is a median over covered legs, one value per leg:

- Sideways: per leg, the RMS over 17 fractions 0.10, 0.15 ... 0.90 of the great-circle distance of the cross-track from the
  great circle, linearly interpolated between the first track points on each side. The great circle's error is the leg's
  cross-track. The library's error is the leg's cross-track minus the library line's. A leg with fewer than 8 valid grid
  points is skipped from every median and counted; it still counts as covered.
- Length: 100 x |actual track length / predicted length - 1|, the actual length being origin, line, destination, the
  predicted one the great circle or the decoded library line.
- Time: the absolute error in minutes of the leg's first-to-last airborne time against `modelledAirborne` in
  `src/lib/model.mjs` with calm wind and the legacy profile (FL350, Mach 0.83, 8 min approach allowance, no stretch), and for
  the library with the route stretch set to library length over great-circle length. Departure is 15 min before the first
  airborne sample.
- Size: the deflate (level 9) size of `index.json`.

**Go** only when all hold; a non-finite value fails closed: coverage at least 0.5; library median sideways at most half the
great circle's; library median length error at most half the great circle's; library median time error no worse than the
legacy model's; zipped `index.json` at most 3 MiB (3,145,728 bytes).

## World confirmation: five build days, two fresh holdout days, 250-2,000 km

The first gate needs a ground report at both ends, which removes almost every flight in Asia, so the confirmation uses a
leg definition that does not.

**What was decided before the held-out days.** The five build days were already held when the confirmation's rules were
written. The world leg rule, the airport matcher and the 94 added operators were chosen from three count-only runs on two
of them (2025.03.26 and 2025.08.27, days the first gate had already used). Those runs measured no duration, model or route
accuracy. 36 stricter matchers were compared under a rule fixed before that run (at most 2 % wrong airports at every
emulated height and region with at least 100 judged ends, then the most usable legs outside North America and Europe). The
chosen matcher was wrong on 0.6 % of 16,330 judged ends (North America 1.0 %, Europe 0.2 %, Oceania/Pacific 0.0 %). The
operators were added from the most frequent unlisted callsign prefixes, keeping only codes identified as passenger airlines. The
matcher was then frozen and judged on the two held-out days only, which were not downloaded until the rules were written.
Known limit: the matcher could be judged only where ground reports exist. Africa, Central America, East Asia, the Middle East
and South America had 3 to 75 judged ends each, and South and Southeast Asia had none, so its error there is assumed, not
measured.

**Leg (world), `python/extract_world.py`.** All rules apply to build and holdout days alike.

1. Aircraft type in the listed jet types (`common.py`).
2. A segment is a run of consecutive `adsb_icao` samples with numeric altitude. A ground row or a gap over 1,200 s ends it. At
   least 5 samples.
3. No gap over 600 s inside the segment. No adjacent pair of samples implying over 1,300 km/h when they are more than 50 km
   apart.
4. Exactly one callsign matching `[A-Z]{3}[0-9][A-Z0-9]{0,4}` whose first three letters are in the listed operators or in the
   world list below.
5. The first and last samples are each accepted by the airport matcher.
6. The two airports differ and are at least 250 km and under 2,000 km apart.
7. At least 10 min from first to last sample.

**Airport matcher.** Candidates are the airport index's rows with IATA and ICAO codes, size large or medium (`size <= 1`) and
scheduled service (`scheduled == 1`). For a sample, take the nearest candidate at distance `d1` and the next nearest at `d2`,
searching the sample's one-degree cell and its eight neighbours. Accept the nearest only when `d1 <= 30 km`, the altitude minus
the field elevation is at most 3,000 ft (a blank elevation counts as 0), and `d2 >= 3 * d1`. With no second candidate, `d2` is
infinite.

**World passenger operators**, added to the listed operators:

`JIA GJS ASH AAY JZA MXY SCX ROU POE FLE VXP VIV EJU WMT ITY NOZ DLA SHT NSZ VOE TVF AEA TRA ANE BTI RUK EFW WUK PGT MAC FDB OMA ABY MEA OMS MSR GFA SXS CYP SKY JNA ABL JJP SFJ IBX APJ AAR TWB JTA CAL MDA JJA SJX HKE TTW EVA APZ EOK CSZ XAX IGO AXB AKJ UBG BBC VJC MXD DAH JAF LBT TAR TFL TUI SLI CAY AIQ AXM TGW TLM BTK TVJ NOK GIA BKP CTV JSA FFM CEB QLK TAM AZU LXP SKU ARG`

A leg's measured line is its samples, one point per 60 s plus the last. A leg is `grounded` when a ground row lies within 60 s
before its first sample and within 60 s after its last.

**Regions** come from the ICAO prefix, first match wins: `K`, `C`, `PA`, `PH` North America; `M`, `T` Central
America/Caribbean; `S` South America; `U` Russia/CIS; `O` Middle East; `D`, `F`, `G`, `H` Africa; `E`, `L`, `B` Europe; `VT`,
`VV`, `VL`, `VD`, `VY`, `RP`, `W` Southeast Asia; `VH`, `VM`, `Z`, `R` East Asia; any other `V` South Asia; `Y`, `N`,
`A`, `P` Oceania/Pacific; otherwise other. A leg counts in every region it touches. Rest of world is every leg touching a region other
than North America and Europe.

**Matcher check on fresh data.** For every `grounded` leg of a holdout day, take the first and last samples at least 2,000 ft
above the true field, the true airport being the nearest airport of the index within 8 km of the ground row. Count right,
wrong and rejected matcher results. If wrong exceeds 2 % of right plus wrong on the two holdout days pooled, the confirmation
is invalid.

**Days.** Build: 2025.03.26, 2025.05.21, 2025.07.30, 2025.08.27, 2025.11.26. Holdout: 2025.02.26, 2025.09.24. The library is
built from the five build days only, with the same `typicalRoute`.

**Scoring (`src/build/world-gate.mjs`).** Sideways, length and time as in the first gate, one value per leg, medians over
covered legs. Time uses only covered `grounded` legs, because other legs start and end up to 3,000 ft above the field. The
flat-stretch time, reported and not gated, uses the median actual-track to great-circle ratio of the build legs.

**Group rule.** A group is a set of holdout legs. It has enough evidence with at least 100 scored legs on at least 10
distinct airport pairs; with less it is `insufficient evidence`, whatever its numbers. A group with enough evidence is
`confirmed` only when all hold, else `not confirmed`: coverage at least 0.5; library median sideways at most half the great
circle's; library median length error at most half the great circle's; in at least two thirds of its scored airport pairs,
the pair's median library sideways is below its median great-circle sideways. A non-finite value is `not confirmed`.

**Decisions.**

1. Range gate (`go`): the pooled 250-2,000 km group is `confirmed`, the library's median time on grounded legs is at most the
   legacy model's, zipped `index.json` is at most 3,145,728 bytes, and the matcher check passes.
2. Confirmed range: groups for 250-500, 500-1,000, 1,000-1,500 and 1,500-2,000 km; the longest contiguous run of `confirmed`
   bands, the shorter-distance run on a tie. Without `go`, none.
3. `worldConfirmed` is true only when `go` is true and the rest-of-world group is `confirmed`.
4. Each region is reported with its class, legs, pairs and coverage. Only a `confirmed` region may be described as confirmed;
   `insufficient evidence` is a shortfall, not evidence for or against that region.

## Release

`src/build/release.mjs` takes the world confirmation's `index.json` (the library of all 6,978 routes), drops every route with
an end in Africa, the Middle East, Southeast Asia, Russia/CIS or an unlisted region (by the prefixes above), writes the
remaining 6,881 as `format: 2` route texts, and checks that each text decodes to exactly the points of the gate's integers.
