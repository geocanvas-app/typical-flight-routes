/**
 * The release: takes the world confirmation's `index.json` (the gate's library), drops every route that touches Africa,
 * the Middle East, Southeast Asia, Russia/CIS or an unlisted region, writes the rest as `format: 2` compact route texts,
 * and checks that each decodes to exactly the gate's points. Writes `typical-routes.json` and a README.txt.
 * Usage: node src/build/release.mjs <version, e.g. 2026.11> <index.json of the world gate> <outDir> [expected index.json SHA-256]
 */
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodeRoute, decodeRouteText} from '../decode.mjs';
import {encodeRouteText, typicalRoutesFile} from '../lib/library.mjs';

/** The released library's index.json, as the world gate wrote it from the real archive days. */
export const GATE_INDEX_SHA = '2e3d2e7bea14dbbc05ba2090cec0e732b265d9a4200f582ad25dad684307f72c';
export const EXPECTED_ROUTES = 6881;

/** The world regions from the ICAO prefix, first match wins. */
export const REGION_PREFIXES = [
  ['K', 'North America'], ['C', 'North America'], ['PA', 'North America'], ['PH', 'North America'],
  ['M', 'Central America/Caribbean'], ['T', 'Central America/Caribbean'], ['S', 'South America'], ['U', 'Russia/CIS'],
  ['O', 'Middle East'], ['D', 'Africa'], ['F', 'Africa'], ['G', 'Africa'], ['H', 'Africa'],
  ['E', 'Europe'], ['L', 'Europe'], ['B', 'Europe'],
  ['VT', 'Southeast Asia'], ['VV', 'Southeast Asia'], ['VL', 'Southeast Asia'], ['VD', 'Southeast Asia'],
  ['VY', 'Southeast Asia'], ['RP', 'Southeast Asia'], ['W', 'Southeast Asia'],
  ['VH', 'East Asia'], ['VM', 'East Asia'], ['Z', 'East Asia'], ['R', 'East Asia'],
  ['V', 'South Asia'],
  ['Y', 'Oceania/Pacific'], ['N', 'Oceania/Pacific'], ['A', 'Oceania/Pacific'], ['P', 'Oceania/Pacific'],
];
const LEFT_OUT = new Set(['Africa', 'Middle East', 'Southeast Asia', 'Russia/CIS', 'other']);
export const regionOf = (icao) => REGION_PREFIXES.find(([prefix]) => icao.startsWith(prefix))?.[1] ?? 'other';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The release's routes ({key: text}) from the gate's ({key: integers}), refusing a route that does not decode to the same points. */
export function releaseRoutes(gate) {
  const routes = {};
  for (const key of Object.keys(gate.routes).sort()) {
    const [origin, destination] = key.split('-');
    if (LEFT_OUT.has(regionOf(origin)) || LEFT_OUT.has(regionOf(destination))) continue;
    const text = encodeRouteText(gate.routes[key]);
    const written = decodeRouteText(text);
    if (!written || JSON.stringify(written) !== JSON.stringify(decodeRoute(gate.routes[key]))) throw new Error(`${key}: the compact text does not decode to the gate's points`);
    routes[key] = text;
  }
  return routes;
}

/** Writes the release folder and returns {count, bytes, sha256}. `expectedRoutes` and `expectedIndexSha` are checked when given. */
export function writeRelease({version, indexPath, outDir, expectedRoutes, expectedIndexSha}) {
  if (!/^\d{4}\.\d{2}$/.test(version)) throw new Error('version must look like 2026.11');
  const raw = readFileSync(indexPath);
  const indexSha = sha256(raw);
  if (expectedIndexSha && indexSha !== expectedIndexSha) throw new Error(`index.json is not the gate's library (SHA-256 ${indexSha})`);
  const gate = JSON.parse(raw.toString('utf8'));
  const routes = releaseRoutes(gate);
  const count = Object.keys(routes).length;
  if (expectedRoutes !== undefined && count !== expectedRoutes) throw new Error(`${count} routes remain, expected ${expectedRoutes}`);

  const base = typicalRoutesFile(version, gate.builtFrom, {});
  const file = {...base, format: 2, routes};
  const bytes = Buffer.from(JSON.stringify(file), 'utf8');
  const fileSha = sha256(bytes);
  mkdirSync(outDir, {recursive: true});
  writeFileSync(join(outDir, 'typical-routes.json'), bytes);
  const readme = [
    `GeoCanvas.Fly typical routes ${version}`,
    '',
    `Attribution: ${base.attribution}`,
    `Licence: Open Database License (ODbL 1.0), ${base.licenseUrl}`,
    `Source: ADSB.lol historical data, ${base.source}`,
    `Source releases (globe_history_2025): ${gate.builtFrom.join(', ')}`,
    '',
    `typical-routes.json: format 2, ${count} routes, ${bytes.length} bytes, SHA-256 ${fileSha}`,
    `Built from the world confirmation library index.json (SHA-256 ${indexSha}, ${Object.keys(gate.routes).length} routes).`,
    '',
    'Method: each route is one directional ICAO pair, `ORIGIN-DESTINATION`, holding the real flight nearest the others on that pair (a medoid, not an average)',
    'simplified to at most 24 points and rounded to hundredths of a degree. A route is written as one URL-safe text: the integers of `encodeRoute`',
    '(the first point, then the deltas, longitude wrapped) are zigzagged and written as base-32 digits, least significant first, in the alphabet',
    '`A-Za-z0-9-_` with bit 5 of a digit as the continuation bit (`encodeRouteText`). Every route here decodes to exactly the same points as the gate file.',
    'Routes with an end in Africa, the Middle East, Southeast Asia, Russia/CIS or an unlisted region (by ICAO prefix, the confirmation protocol\'s order) are left out,',
    'because the confirmation could not judge them. The file holds no flight, aircraft or operator identity.',
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'README.txt'), readme);
  return {count, bytes: bytes.length, sha256: fileSha, gateRoutes: Object.keys(gate.routes).length};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [version, indexPath, outDir, expectedIndexSha] = process.argv.slice(2);
  if (!version || !indexPath || !outDir) throw new Error('usage: release.mjs <version> <index.json> <outDir> [expected index.json SHA-256]');
  // With the released library's hash, also require the released route count.
  const r = writeRelease({version, indexPath, outDir, expectedIndexSha, expectedRoutes: expectedIndexSha === GATE_INDEX_SHA ? EXPECTED_ROUTES : undefined});
  console.log(`${r.count} of ${r.gateRoutes} routes, ${r.bytes} bytes, SHA-256 ${r.sha256}`);
  console.log(`written to ${join(outDir, 'typical-routes.json')}`);
}
