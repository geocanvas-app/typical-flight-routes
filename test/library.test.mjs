import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeRoute, decodeRouteText, routeLineFrom} from '../src/decode.mjs';
import {encodeRoute, encodeRouteText, typicalRoute, typicalRoutesFile} from '../src/lib/library.mjs';

const O = [0, 50], D = [10, 50];
const track = (day, northDeg) => ({day, line: [O, [5, 50 + northDeg], D]});
const near = (a, b, digits = 2) => assert.ok(Math.abs(a - b) < 0.5 * 10 ** -digits, `${a} vs ${b}`);

test('a typical route needs three flights on two days', () => {
  assert.equal(typicalRoute([track('a', 1), track('b', 1)], O, D), null);
  assert.equal(typicalRoute([track('a', 1), track('a', 1), track('a', 1)], O, D), null);
});

test('takes the real flight nearest the others, not an average', () => {
  const line = typicalRoute([track('a', 1), track('a', 1.05), track('a', 1.1), track('b', 1.15), track('b', 4)], O, D);
  near(Math.max(...line.map((p) => p[1])), 51.1, 1);
});

test('ends exactly on both airports with at most 24 points', () => {
  const wiggly = [O, ...Array.from({length: 300}, (_, i) => [i / 30, 50 + Math.sin(i / 3)]), D];
  const line = typicalRoute([{day: 'a', line: wiggly}, {day: 'a', line: wiggly}, {day: 'b', line: wiggly}], O, D);
  assert.deepEqual(line[0], O);
  assert.deepEqual(line.at(-1), D);
  assert.ok(line.length <= 24);
});

test('judges a bend by true kilometres at high latitude, not by the first point\'s latitude', () => {
  const north = Array.from({length: 21}, (_, i) => [0, 60 + i]);
  const bent = (lon) => [[0, 0], ...north.map((p) => (p[1] === 70 ? [lon, 70] : p))];
  const route = (lon) => {
    const line = bent(lon);
    return typicalRoute([{day: 'a', line}, {day: 'a', line}, {day: 'b', line}], [0, 0], [0, 80]);
  };
  // 0.1 deg of longitude at 70N is 3.8 km (under the 5 km tolerance), though 11 km at the equator.
  assert.equal(route(0.1).length, 2);
  // 0.5 deg is 19 km at 70N.
  assert.ok(route(0.5).some((p) => p[0] === 0.5));
});

test('round-trips to 0.01 degree, across the antimeridian', () => {
  const line = [[179.5, 10], [-179.8, 11], [-178.2, 12]];
  decodeRoute(encodeRoute(line)).forEach((p, i) => {
    near(p[0], line[i][0]);
    near(p[1], line[i][1]);
  });
  assert.ok(encodeRoute(line)[2] < 100);
});

test('rejects a corrupt entry', () => {
  assert.equal(decodeRoute([1, 2, 3]), null);
  assert.equal(decodeRoute([1, 9999, 0, 0]), null);
});

test('writes a route as URL-safe text and reads it back, negative, zero and multi-digit deltas included', () => {
  const encoded = [-17950, 1000, 0, -1, 35999, 40, -32, 1, 31, 32, 33, 0];
  const text = encodeRouteText(encoded);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeRouteText(text), decodeRoute(encoded));
  const line = [[179.5, 10], [-179.8, 11], [-178.2, 12]];
  assert.deepEqual(decodeRouteText(encodeRouteText(encodeRoute(line))), decodeRoute(encodeRoute(line)));
});

test('a text with a half-written number or a bad character is null (a cut on a point boundary is not detected: the file hash covers that)', () => {
  const text = encodeRouteText(encodeRoute([[8.57, 50.03], [-30, 62], [-73.78, 40.64]]));
  assert.equal(decodeRouteText(text.slice(0, -1)), null);
  assert.equal(decodeRouteText('!'), null);
});

test('replaces the decoded ends with the airports exactly', () => {
  const text = encodeRouteText(encodeRoute([[8.57, 50.03], [-30, 62], [-73.78, 40.64]]));
  assert.deepEqual(routeLineFrom(text, [8.5705, 50.0333], [-73.7781, 40.6413]), [[8.5705, 50.0333], [-30, 62], [-73.7781, 40.6413]]);
  assert.equal(routeLineFrom('!', O, D), null);
});

test('carries the ODbL notice and no flight identity', () => {
  const file = typicalRoutesFile('2026.1', ['v2025.03.26-planes-readsb-prod-0'], {'EDDF-KJFK': [1, 2, 3, 4]});
  assert.equal(file.format, 1);
  assert.equal(file.license, 'ODbL-1.0');
  assert.equal(file.attribution, 'Contains information from ADSB.lol, which is made available under the Open Database License (ODbL 1.0).');
  assert.equal(file.source, 'https://www.adsb.lol/docs/open-data/historical');
  assert.deepEqual(Object.keys(file).sort(), ['attribution', 'builtFrom', 'format', 'license', 'licenseUrl', 'routes', 'source', 'version']);
});
