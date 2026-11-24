import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {decodeFile, decodeRouteText, routeKey} from '../src/decode.mjs';
import {sha256Hex, verifyFile} from '../src/verify.mjs';

const RELEASE = new URL('../data/2026.11/typical-routes.json', import.meta.url);
const SHA = '83d2c851e56645824d4e5a13414e2e85b75c07fff835b7139c113096664ebac8';
const bytes = readFileSync(RELEASE);
const reference = JSON.parse(readFileSync(new URL('./fixtures/expected/original-decode-and-model.json', import.meta.url), 'utf8'));

test('the release file has the published size and SHA-256', () => {
  assert.equal(bytes.length, 350873);
  assert.equal(sha256Hex(bytes), SHA);
  assert.ok(verifyFile(bytes, SHA.toUpperCase()));
  assert.ok(!verifyFile(Buffer.concat([bytes, Buffer.from(' ')]), SHA));
});

test('the release file carries the notice and the source releases', () => {
  const file = JSON.parse(bytes.toString('utf8'));
  assert.equal(file.format, 2);
  assert.equal(file.version, '2026.11');
  assert.equal(file.license, 'ODbL-1.0');
  assert.equal(file.licenseUrl, 'https://opendatacommons.org/licenses/odbl/1-0/');
  assert.equal(file.attribution, 'Contains information from ADSB.lol, which is made available under the Open Database License (ODbL 1.0).');
  assert.deepEqual(file.builtFrom, [
    'v2025.03.26-planes-readsb-prod-0', 'v2025.05.21-planes-readsb-prod-0', 'v2025.07.30-planes-readsb-prod-0',
    'v2025.08.27-planes-readsb-staging-0', 'v2025.11.26-planes-readsb-staging-0',
  ]);
  assert.deepEqual(Object.keys(file).sort(), ['attribution', 'builtFrom', 'format', 'license', 'licenseUrl', 'routes', 'source', 'version']);
});

test('decodes the whole file: 6,881 routes, first and last equal to the original reader, whole decode equal by hash', () => {
  const routes = decodeFile(JSON.parse(bytes.toString('utf8')));
  const keys = Object.keys(routes);
  assert.equal(keys.length, 6881);
  assert.equal(reference.routeCount, 6881);
  assert.equal(keys[0], reference.first.key);
  assert.deepEqual(routes[keys[0]], reference.first.points);
  assert.equal(keys.at(-1), reference.last.key);
  assert.deepEqual(routes[keys.at(-1)], reference.last.points);
  assert.equal(createHash('sha256').update(JSON.stringify(routes)).digest('hex'), reference.decodedSha);
});

test('every route is a directional ICAO pair of 2 to 24 points with valid coordinates', () => {
  const routes = decodeFile(JSON.parse(bytes.toString('utf8')));
  for (const [key, line] of Object.entries(routes)) {
    const [o, d] = key.split('-');
    assert.match(o, /^[A-Z0-9]{4}$/);
    assert.match(d, /^[A-Z0-9]{4}$/);
    assert.notEqual(o, d);
    assert.ok(line.length >= 2 && line.length <= 24, `${key} has ${line.length} points`);
    for (const [lon, lat] of line) assert.ok(lon >= -180 && lon < 180 && Math.abs(lat) <= 90, key);
  }
});

test('rejects what is not format 2, a bad character, a half-written number', () => {
  assert.throws(() => decodeFile({format: 1, routes: {}}), /format/);
  assert.equal(decodeRouteText('!'), null);
  assert.equal(decodeRouteText(''), null);
  assert.equal(decodeRouteText('AAA'), null);
  assert.equal(routeKey('EDDF', 'LFPG'), 'EDDF-LFPG');
});
