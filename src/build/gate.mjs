/**
 * The first gate: does a library of typical routes, built from three archive days, predict the legs of two other days?
 * Builds the library from the three build days' legs, scores every qualifying leg of the two holdout days, writes
 * index.json and result.json, prints one go value.
 * Usage: node src/build/gate.mjs [inputDir] [outDir]     (defaults: work/legs-gate)
 * Input: legs-<day>.jsonl from python/extract_gate.py.
 */
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodeRoute} from '../decode.mjs';
import {encodeRoute, routeKey, typicalRoute, typicalRoutesFile} from '../lib/library.mjs';
import {zippedBytes} from '../lib/measure.mjs';
import {legacyProfile, modelledAirborne} from '../lib/model.mjs';
import {typicalRoutesVerdict} from '../lib/rules.mjs';
import {crossAt, dist, GRID, MIN, MIN_GRID_POINTS, pathM} from '../lib/score.mjs';

export const BUILD_DAYS = ['2025.03.26', '2025.07.30', '2025.11.26'];
export const HOLDOUT_DAYS = ['2025.05.21', '2025.08.27'];
export const RELEASES = {
  '2025.03.26': 'v2025.03.26-planes-readsb-prod-0', '2025.07.30': 'v2025.07.30-planes-readsb-prod-0',
  '2025.11.26': 'v2025.11.26-planes-readsb-staging-0', '2025.05.21': 'v2025.05.21-planes-readsb-prod-0',
  '2025.08.27': 'v2025.08.27-planes-readsb-staging-0',
};

const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) / 2;
  return (s[Math.floor(i)] + s[Math.ceil(i)]) / 2;
};

/** All of a day's legs. A missing file, no legs, or a row of another day or release throws: the gate never scores a partial set. */
function readLegs(dir, day) {
  const legs = readFileSync(join(dir, `legs-${day}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (!legs.length) throw new Error(`legs-${day}.jsonl has no legs`);
  const wrong = legs.findIndex((l) => l.day !== day || l.release !== RELEASES[day]);
  if (wrong >= 0) throw new Error(`legs-${day}.jsonl row ${wrong + 1} is day ${legs[wrong].day}, release ${legs[wrong].release}; expected ${day}, ${RELEASES[day]}`);
  return legs;
}

export function runGate(inputDir, outDir = inputDir, log = console.log) {
  mkdirSync(outDir, {recursive: true});

  // Library: built from the build days only.
  const build = BUILD_DAYS.map((day) => readLegs(inputDir, day));
  const holdout = HOLDOUT_DAYS.flatMap((day) => readLegs(inputDir, day));
  const builtFrom = [...new Set(build.flat().map((l) => l.release))];
  if (builtFrom.join() !== BUILD_DAYS.map((d) => RELEASES[d]).join()) throw new Error(`builtFrom is ${builtFrom.join()}, not the three build releases`);
  const groups = new Map();
  for (const l of build.flat()) {
    const key = routeKey(l.originIcao, l.destinationIcao);
    const group = groups.get(key) ?? {origin: l.origin, destination: l.destination, tracks: []};
    group.tracks.push({day: l.day, line: l.line});
    groups.set(key, group);
  }
  const routes = {};
  for (const [key, g] of groups) {
    const line = typicalRoute(g.tracks, g.origin, g.destination);
    if (line) routes[key] = encodeRoute(line);
  }
  const file = typicalRoutesFile('private-gate', builtFrom, routes);
  const indexBytes = Buffer.from(JSON.stringify(file), 'utf8');
  writeFileSync(join(outDir, 'index.json'), indexBytes);

  // Holdout: every qualifying leg of the two holdout days.
  const regions = ['US', 'Europe', 'other'];
  const total = {}, covered = {};
  const rows = [];
  let coveredLegs = 0, skipped = 0;
  for (const l of holdout) {
    total[l.region] = (total[l.region] ?? 0) + 1;
    const encoded = routes[routeKey(l.originIcao, l.destinationIcao)];
    const library = encoded ? decodeRoute(encoded) : null;
    if (!library) continue;
    coveredLegs++;
    covered[l.region] = (covered[l.region] ?? 0) + 1;

    const gcM = dist(l.origin, l.destination);
    const leg = crossAt(l.origin, l.destination, l.line, gcM);
    const lib = crossAt(l.origin, l.destination, library, gcM);
    const both = GRID.map((_, i) => (leg[i] !== null && lib[i] !== null ? [leg[i], lib[i]] : null)).filter((v) => v !== null);
    if (both.length < MIN_GRID_POINTS) {skipped++; continue;}
    const rms = (f) => Math.sqrt(both.reduce((s, v) => s + f(v) ** 2, 0) / both.length) / 1000;

    const actualM = pathM([l.origin, ...l.line, l.destination]);
    const libraryM = pathM(library);
    const observedMin = (l.lastAirMs - l.firstAirMs) / MIN;
    const p = legacyProfile();
    const modelled = (timing) => modelledAirborne({
      origin: l.origin, destination: l.destination, departureMs: l.firstAirMs - 15 * MIN, cruiseAltM: p.cruiseAltM, timing, wind: () => null,
    }).airborneMs / MIN;
    const row = {
      gcSideways: rms((v) => v[0]), libSideways: rms((v) => v[0] - v[1]),
      gcLength: 100 * Math.abs(actualM / gcM - 1), libLength: 100 * Math.abs(actualM / libraryM - 1),
      activeTime: Math.abs(observedMin - modelled(p)), libTime: Math.abs(observedMin - modelled({...p, routeStretch: libraryM / gcM})),
    };
    const bad = Object.entries(row).find(([, v]) => !Number.isFinite(v));
    if (bad) throw new Error(`Non-finite ${bad[0]} for holdout leg ${l.day} ${l.originIcao}-${l.destinationIcao} at ${l.firstAirMs}`);
    rows.push(row);
  }

  const measures = {
    coverage: holdout.length ? coveredLegs / holdout.length : NaN,
    gcSidewaysKm: median(rows.map((r) => r.gcSideways)), libSidewaysKm: median(rows.map((r) => r.libSideways)),
    gcLengthPct: median(rows.map((r) => r.gcLength)), libLengthPct: median(rows.map((r) => r.libLength)),
    activeTimeMin: median(rows.map((r) => r.activeTime)), libTimeMin: median(rows.map((r) => r.libTime)),
    zippedBytes: zippedBytes(indexBytes),
  };
  const verdict = typicalRoutesVerdict(measures);
  const byRegion = Object.fromEntries(regions.map((r) => [r, {legs: total[r] ?? 0, covered: covered[r] ?? 0, coverage: total[r] ? (covered[r] ?? 0) / total[r] : NaN}]));
  const result = {
    ...verdict, measures, libraryPairs: Object.keys(routes).length, buildLegs: build.flat().length, buildPairs: groups.size, builtFrom,
    holdoutDays: HOLDOUT_DAYS, holdoutLegs: holdout.length, coveredLegs, scoredLegs: rows.length, skippedFewerThan8GridPoints: skipped,
    rawBytes: indexBytes.length, byRegion,
  };
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 1));

  const n = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'NaN');
  log(`library: ${result.libraryPairs} airport pairs from ${result.buildPairs} build pairs, ${result.buildLegs} build legs; ${indexBytes.length} bytes raw, ${measures.zippedBytes} zipped`);
  log(`holdout: ${holdout.length} legs, ${coveredLegs} covered, ${rows.length} scored, ${skipped} skipped for fewer than ${MIN_GRID_POINTS} grid points`);
  log(`1 coverage   ${n(measures.coverage, 4)} (needs >= 0.5)`);
  log(`2 sideways   library ${n(measures.libSidewaysKm)} km vs great circle ${n(measures.gcSidewaysKm)} km (needs <= half)`);
  log(`3 length     library ${n(measures.libLengthPct)} % vs great circle ${n(measures.gcLengthPct)} % (needs <= half)`);
  log(`4 time       library ${n(measures.libTimeMin)} min vs active ${n(measures.activeTimeMin)} min (needs no worse)`);
  log(`5 size       ${measures.zippedBytes} bytes zipped (needs <= ${3 * 1024 * 1024})`);
  for (const r of regions) log(`coverage ${r.padEnd(6)} ${byRegion[r].covered}/${byRegion[r].legs} = ${n(byRegion[r].coverage, 3)}`);
  log(`go: ${verdict.go}${verdict.failed.length ? ` (failed: ${verdict.failed.join(', ')})` : ''}`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [inputDir = 'work/legs-gate', outDir = inputDir] = process.argv.slice(2);
  runGate(inputDir, outDir);
}
