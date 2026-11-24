import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeRoute, decodeRouteText} from '../src/decode.mjs';
import {encodeRoute, typicalRoutesFile} from '../src/lib/library.mjs';
import {regionOf, releaseRoutes} from '../src/build/release.mjs';

test('reads the world regions from the ICAO prefix, first match wins', () => {
  assert.deepEqual(['KJFK', 'CYYZ', 'PANC', 'PHNL', 'MMMX', 'SBGR', 'UUEE', 'OMDB', 'FACT', 'EDDF', 'LFPG', 'BIKF', 'VTBS', 'WSSS', 'RPLL', 'VHHH', 'RJTT', 'ZBAA', 'VIDP', 'YSSY', 'NZAA', 'AGGH', 'PGUM', 'XXXX'].map(regionOf), [
    'North America', 'North America', 'North America', 'North America', 'Central America/Caribbean', 'South America', 'Russia/CIS', 'Middle East', 'Africa', 'Europe', 'Europe', 'Europe',
    'Southeast Asia', 'Southeast Asia', 'Southeast Asia', 'East Asia', 'East Asia', 'East Asia', 'South Asia', 'Oceania/Pacific', 'Oceania/Pacific', 'Oceania/Pacific', 'Oceania/Pacific', 'other',
  ]);
});

test('keeps a route only when both ends are outside the regions the confirmation could not judge, each decoding to the gate\'s points', () => {
  const line = (...points) => encodeRoute(points);
  const gate = typicalRoutesFile('private', ['v1'], {
    'EDDF-KJFK': line([8.57, 50.03], [-30, 62], [-73.78, 40.64]),
    'KLAX-RJTT': line([-118.41, 33.94], [179.5, 50], [-179.8, 51], [139.78, 35.55]),
    'EDDF-FACT': line([8.57, 50.03], [18.6, -33.96]),
    'OMDB-EDDF': line([55.36, 25.25], [8.57, 50.03]),
    'WSSS-RJTT': line([103.99, 1.36], [139.78, 35.55]),
    'UUEE-EDDF': line([37.41, 55.97], [8.57, 50.03]),
    'EDDF-XXXX': line([8.57, 50.03], [1, 2]),
  });
  const kept = releaseRoutes(gate);
  assert.deepEqual(Object.keys(kept), ['EDDF-KJFK', 'KLAX-RJTT']);
  for (const key of Object.keys(kept)) assert.deepEqual(decodeRouteText(kept[key]), decodeRoute(gate.routes[key]));
});
