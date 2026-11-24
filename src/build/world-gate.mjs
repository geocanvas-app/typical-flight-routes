/**
 * The 250-2,000 km world confirmation. Builds the library from the five build days' legs, scores every qualifying leg of
 * the two holdout days, writes index.json and result.json, prints the decisions. Run once: it refuses to overwrite a
 * result.json or index.json in the output folder.
 * Usage: node src/build/world-gate.mjs [inputDir] [outDir]     (defaults: work/legs-world)
 * Input: legs-<day>.jsonl and check-<day>.json from python/extract_world.py.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodeRoute} from '../decode.mjs';
import {encodeRoute, routeKey, typicalRoute, typicalRoutesFile} from '../lib/library.mjs';
import {zippedBytes} from '../lib/measure.mjs';
import {legacyProfile, modelledAirborne} from '../lib/model.mjs';
import {worldDecisions, worldGroupClass} from '../lib/rules.mjs';
import {crossAt, dist, GRID, MIN, MIN_GRID_POINTS, pathM} from '../lib/score.mjs';

export const BUILD_DAYS = ['2025.03.26', '2025.05.21', '2025.07.30', '2025.08.27', '2025.11.26'];
export const HOLDOUT_DAYS = ['2025.02.26', '2025.09.24'];
export const RELEASES = {
  '2025.02.26': 'v2025.02.26-planes-readsb-prod-0', '2025.03.26': 'v2025.03.26-planes-readsb-prod-0',
  '2025.05.21': 'v2025.05.21-planes-readsb-prod-0', '2025.07.30': 'v2025.07.30-planes-readsb-prod-0',
  '2025.08.27': 'v2025.08.27-planes-readsb-staging-0', '2025.09.24': 'v2025.09.24-planes-readsb-staging-0',
  '2025.11.26': 'v2025.11.26-planes-readsb-staging-0',
};
export const REGIONS = ['North America', 'Central America/Caribbean', 'South America', 'Russia/CIS', 'Middle East', 'Africa', 'Europe',
  'Southeast Asia', 'East Asia', 'South Asia', 'Oceania/Pacific', 'other'];
const IN_BASE_REGIONS = ['North America', 'Europe'];
const BANDS = [[250, 500], [500, 1000], [1000, 1500], [1500, 2000]];

const median = (xs) => {
  if (!xs.length || xs.some((x) => !Number.isFinite(x))) return NaN; // one bad value fails the group closed
  const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) / 2;
  return (s[Math.floor(i)] + s[Math.ceil(i)]) / 2;
};

const rows = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean);

/** All of a day's legs. A missing file, no legs, a malformed row or a row of another day or release throws: the gate never scores a partial set. */
function readLegs(dir, day) {
  const legs = rows(join(dir, `legs-${day}.jsonl`)).map((l) => JSON.parse(l));
  if (!legs.length) throw new Error(`legs-${day}.jsonl has no legs`);
  const wrong = legs.findIndex((l) => l.day !== day || l.release !== RELEASES[day]);
  if (wrong >= 0) throw new Error(`legs-${day}.jsonl row ${wrong + 1} is day ${legs[wrong].day}, release ${legs[wrong].release}; expected ${day}, ${RELEASES[day]}`);
  const bad = legs.findIndex((l) => typeof l.grounded !== 'boolean' || !Array.isArray(l.regions) || !Array.isArray(l.line) || !(l.distanceKm >= 250 && l.distanceKm < 2000));
  if (bad >= 0) throw new Error(`legs-${day}.jsonl row ${bad + 1} is not a 250-2,000 km world leg`);
  return legs;
}

function readCheck(dir, day) {
  const c = JSON.parse(readFileSync(join(dir, `check-${day}.json`), 'utf8'));
  if (c.day !== day || c.release !== RELEASES[day]) throw new Error(`check-${day}.json is day ${c.day}, release ${c.release}; expected ${day}, ${RELEASES[day]}`);
  for (const k of ['right', 'wrong', 'rejected', 'noTruth']) {
    if (!Number.isInteger(c[k]) || c[k] < 0) throw new Error(`check-${day}.json ${k} is ${c[k]}`);
  }
  return c;
}

export function runWorldGate(inputDir, outDir = inputDir, log = console.log) {
  // Refuse before anything else: every leg and check file must be present and well formed.
  const build = BUILD_DAYS.map((day) => readLegs(inputDir, day)).flat();
  const holdoutByDay = HOLDOUT_DAYS.map((day) => readLegs(inputDir, day));
  const checks = HOLDOUT_DAYS.map((day) => readCheck(inputDir, day));
  const holdout = holdoutByDay.flat();
  const builtFrom = [...new Set(build.map((l) => l.release))];
  if (builtFrom.join() !== BUILD_DAYS.map((d) => RELEASES[d]).join()) throw new Error(`builtFrom is ${builtFrom.join()}, not the five build releases`);
  // One gate run: a result or index already in the output folder blocks another.
  for (const name of ['result.json', 'index.json']) {
    if (existsSync(join(outDir, name))) throw new Error(`${join(outDir, name)} already exists. The gate runs once, so this run is refused.`);
  }
  mkdirSync(outDir, {recursive: true});

  // Library: built from the five build days only, one line per directional ICAO pair.
  const groups = new Map();
  for (const l of build) {
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
  const file = typicalRoutesFile('private-world-confirmation', builtFrom, routes);
  const indexBytes = Buffer.from(JSON.stringify(file), 'utf8');
  writeFileSync(join(outDir, 'index.json'), indexBytes);

  // Flat-stretch time (reported, not gated): the median actual-track to great-circle ratio of the build legs.
  const flatStretch = median(build.map((l) => pathM([l.origin, ...l.line, l.destination]) / dist(l.origin, l.destination)));

  // Holdout: every qualifying leg of the two holdout days, scored on the decoded library line.
  const held = [];
  let skipped = 0, nonFinite = 0;
  for (const l of holdout) {
    const encoded = routes[routeKey(l.originIcao, l.destinationIcao)];
    const library = encoded ? decodeRoute(encoded) : null;
    if (!library) {held.push({leg: l, covered: false, scored: null}); continue;}

    const gcM = dist(l.origin, l.destination);
    const leg = crossAt(l.origin, l.destination, l.line, gcM);
    const lib = crossAt(l.origin, l.destination, library, gcM);
    const both = GRID.map((_, i) => (leg[i] !== null && lib[i] !== null ? [leg[i], lib[i]] : null)).filter((v) => v !== null);
    if (both.length < MIN_GRID_POINTS) {skipped++; held.push({leg: l, covered: true, scored: null}); continue;}
    const rms = (f) => Math.sqrt(both.reduce((s, v) => s + f(v) ** 2, 0) / both.length) / 1000;

    const actualM = pathM([l.origin, ...l.line, l.destination]);
    const libraryM = pathM(library);
    let times = null;
    if (l.grounded) {
      const observedMin = (l.lastAirMs - l.firstAirMs) / MIN;
      const p = legacyProfile();
      const modelled = (timing) => modelledAirborne({
        origin: l.origin, destination: l.destination, departureMs: l.firstAirMs - 15 * MIN, cruiseAltM: p.cruiseAltM, timing, wind: () => null,
      }).airborneMs / MIN;
      times = {
        activeTime: Math.abs(observedMin - modelled(p)), libTime: Math.abs(observedMin - modelled({...p, routeStretch: libraryM / gcM})),
        flatTime: Math.abs(observedMin - modelled({...p, routeStretch: flatStretch})),
      };
    }
    const scored = {
      key: routeKey(l.originIcao, l.destinationIcao), gcSideways: rms((v) => v[0]), libSideways: rms((v) => v[0] - v[1]),
      gcLength: 100 * Math.abs(actualM / gcM - 1), libLength: 100 * Math.abs(actualM / libraryM - 1), times,
    };
    if (![scored.gcSideways, scored.libSideways, scored.gcLength, scored.libLength, ...(times ? Object.values(times) : [])].every(Number.isFinite)) nonFinite++;
    held.push({leg: l, covered: true, scored});
  }

  /** The group measures over a set of holdout legs. */
  function measure(members) {
    const scored = members.flatMap((m) => (m.scored ? [m.scored] : []));
    const byPair = new Map();
    for (const s of scored) byPair.set(s.key, [...(byPair.get(s.key) ?? []), s]);
    const better = [...byPair.values()].filter((v) => median(v.map((s) => s.libSideways)) < median(v.map((s) => s.gcSideways))).length;
    const timed = scored.flatMap((s) => (s.times ? [s.times] : []));
    const m = {
      legs: members.length, coveredLegs: members.filter((h) => h.covered).length,
      coverage: members.length ? members.filter((h) => h.covered).length / members.length : NaN,
      scoredLegs: scored.length, scoredPairs: byPair.size, pairsBetterShare: byPair.size ? better / byPair.size : NaN,
      gcSidewaysKm: median(scored.map((s) => s.gcSideways)), libSidewaysKm: median(scored.map((s) => s.libSideways)),
      gcLengthPct: median(scored.map((s) => s.gcLength)), libLengthPct: median(scored.map((s) => s.libLength)),
      groundedScoredLegs: timed.length, activeTimeMin: median(timed.map((t) => t.activeTime)), libTimeMin: median(timed.map((t) => t.libTime)),
      flatTimeMin: median(timed.map((t) => t.flatTime)),
    };
    return {...m, class: worldGroupClass(m)};
  }

  const pooled = measure(held);
  const bandResults = BANDS.map(([lowKm, highKm]) => ({lowKm, highKm, ...measure(held.filter((h) => h.leg.distanceKm >= lowKm && h.leg.distanceKm < highKm))}));
  const regionResults = REGIONS.map((region) => ({region, ...measure(held.filter((h) => h.leg.regions.includes(region)))}));
  const worldMembers = held.filter((h) => h.leg.regions.some((r) => !IN_BASE_REGIONS.includes(r)));
  const outside = REGIONS.filter((r) => !IN_BASE_REGIONS.includes(r));
  const share = (members) => {
    const counts = outside.map((region) => ({region, legs: members.filter((h) => h.leg.regions.includes(region)).length}));
    const top = counts.reduce((a, b) => (b.legs > a.legs ? b : a));
    return {region: top.legs ? top.region : null, legs: top.legs, share: members.length ? top.legs / members.length : NaN};
  };
  const restOfWorld = {
    ...measure(worldMembers),
    largestRegionByScoredLegs: share(worldMembers.filter((h) => h.scored)),
    largestRegionByHoldoutLegs: share(worldMembers),
  };

  const matcher = {
    right: checks.reduce((s, c) => s + c.right, 0), wrong: checks.reduce((s, c) => s + c.wrong, 0),
    rejected: checks.reduce((s, c) => s + c.rejected, 0), noTruth: checks.reduce((s, c) => s + c.noTruth, 0),
  };
  const bands = bandResults.map((b) => ({lowKm: b.lowKm, highKm: b.highKm, cls: b.class}));
  const decisions = worldDecisions({
    pooledClass: pooled.class, libTimeMin: pooled.libTimeMin, activeTimeMin: pooled.activeTimeMin, zippedBytes: zippedBytes(indexBytes),
    matcherRight: matcher.right, matcherWrong: matcher.wrong, bands, restOfWorldClass: restOfWorld.class,
  });

  const result = {
    decisions,
    measures: {pooled, zippedBytes: zippedBytes(indexBytes), rawBytes: indexBytes.length},
    matcherCheck: {...matcher, wrongShareOfJudged: matcher.right + matcher.wrong ? matcher.wrong / (matcher.right + matcher.wrong) : NaN, perDay: checks},
    bands: bandResults, regions: regionResults, restOfWorld,
    flatStretch: {routeStretch: flatStretch, flatTimeMin: pooled.flatTimeMin, libTimeMin: pooled.libTimeMin, activeTimeMin: pooled.activeTimeMin},
    libraryPairs: Object.keys(routes).length, buildLegs: build.length, buildPairs: groups.size, builtFrom,
    holdoutDays: HOLDOUT_DAYS, holdoutLegs: holdout.length, skippedFewerThan8GridPoints: skipped, nonFiniteScoredLegs: nonFinite,
  };
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 1));

  const n = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'NaN');
  const line = (name, g) =>
    `${name.padEnd(26)} ${g.class.padEnd(21)} legs ${g.legs}, scored ${g.scoredLegs}, pairs ${g.scoredPairs}, coverage ${n(g.coverage, 3)}`;
  log(`library: ${result.libraryPairs} airport pairs from ${result.buildPairs} build pairs, ${result.buildLegs} build legs; ${indexBytes.length} bytes raw, ${result.measures.zippedBytes} zipped`);
  log(`holdout: ${holdout.length} legs, ${skipped} skipped for fewer than ${MIN_GRID_POINTS} grid points, ${nonFinite} with a non-finite value`);
  log(line('pooled 250-2,000 km', pooled));
  log(`  sideways library ${n(pooled.libSidewaysKm)} km vs great circle ${n(pooled.gcSidewaysKm)} km; length ${n(pooled.libLengthPct)} % vs ${n(pooled.gcLengthPct)} %; pairs better ${n(pooled.pairsBetterShare, 3)}`);
  log(`  grounded time library ${n(pooled.libTimeMin)} min vs active ${n(pooled.activeTimeMin)} min (flat stretch ${n(flatStretch, 3)}: ${n(pooled.flatTimeMin)} min), ${pooled.groundedScoredLegs} legs`);
  log(`matcher check: ${matcher.right} right, ${matcher.wrong} wrong, ${matcher.rejected} rejected, ${matcher.noTruth} no truth`);
  for (const b of bandResults) log(line(`${b.lowKm}-${b.highKm} km`, b));
  for (const r of regionResults) log(line(r.region, r));
  log(line('rest of world', restOfWorld));
  log(`  largest rest-of-world region: ${restOfWorld.largestRegionByScoredLegs.region} with ${n(restOfWorld.largestRegionByScoredLegs.share, 3)} of scored legs`);
  const range = decisions.confirmedRange;
  log(`confirmed range: ${range ? `${range.lowKm}-${range.highKm} km` : 'none'}; worldConfirmed: ${decisions.worldConfirmed}`);
  log(`go: ${decisions.go}${decisions.failed.length ? ` (failed: ${decisions.failed.join(', ')})` : ''}`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [inputDir = 'work/legs-world', outDir = inputDir] = process.argv.slice(2);
  runWorldGate(inputDir, outDir);
}
