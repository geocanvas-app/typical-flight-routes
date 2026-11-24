/**
 * Building the library: the typical route of one airport pair (a medoid of its flights, simplified), and writing a route
 * as integers (`encodeRoute`) and as text (`encodeRouteText`). Positions are [lon, lat]. Reading is in `../decode.mjs`.
 */
import {inverse} from './geodesy.mjs';
import {TEXT_DIGITS, wrapHundredths, routeKey} from '../decode.mjs';

export {routeKey};

export function typicalRoutesFile(version, builtFrom, routes) {
  return {
    format: 1,
    version,
    license: 'ODbL-1.0',
    licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    attribution: 'Contains information from ADSB.lol, which is made available under the Open Database License (ODbL 1.0).',
    source: 'https://www.adsb.lol/docs/open-data/historical',
    builtFrom: [...builtFrom],
    routes,
  };
}

const SAMPLES = 33;
const MAX_POINTS = 24;
const START_TOLERANCE_M = 5000;
const EARTH_R = 6371008.8;
const RAD = Math.PI / 180;

/** Signed longitude difference b - a wrapped to [-180, 180). */
const dLon = (a, b) => ((((b - a + 180) % 360) + 360) % 360) - 180;

function resample(line) {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + inverse(line[i - 1], line[i]).distanceM);
  const total = cum[cum.length - 1];
  const out = [];
  let seg = 1;
  for (let k = 0; k < SAMPLES; k++) {
    const target = (total * k) / (SAMPLES - 1);
    while (seg < line.length - 1 && cum[seg] < target) seg++;
    const span = cum[seg] - cum[seg - 1];
    const t = span > 0 ? Math.min(1, Math.max(0, (target - cum[seg - 1]) / span)) : 0;
    const a = line[seg - 1], b = line[seg];
    out.push([a[0] + dLon(a[0], b[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

function meanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += inverse(a[i], b[i]).distanceM;
  return sum / a.length;
}

/** Douglas-Peucker in a local equirectangular frame (antimeridian-safe). */
function simplify(line, toleranceM) {
  const lat0 = line[0][1];
  const lon0 = line[0][0];
  // The mean latitude scales longitude, so a line that climbs far from its first point keeps true kilometres.
  const meanLat = line.reduce((s, p) => s + p[1], 0) / line.length;
  const kx = Math.cos(meanLat * RAD) * RAD * EARTH_R;
  const ky = RAD * EARTH_R;
  const pts = line.map((p) => [dLon(lon0, p[0]) * kx, (p[1] - lat0) * ky]);
  const keep = new Array(line.length).fill(false);
  keep[0] = keep[line.length - 1] = true;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = pts[s], [bx, by] = pts[e];
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy;
    let worst = -1, worstD = toleranceM;
    for (let i = s + 1; i < e; i++) {
      const wx = pts[i][0] - ax, wy = pts[i][1] - ay;
      const t = len2 > 0 ? Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2)) : 0;
      const d = Math.hypot(wx - t * vx, wy - t * vy);
      if (d > worstD) {worstD = d; worst = i;}
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([s, worst], [worst, e]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

/**
 * The typical route of one airport pair: of the pair's `tracks` ({day, line}), the real flight with the least summed
 * mean distance to all the others (a medoid, not an average), simplified to at most 24 points, with both ends replaced by
 * the airports' coordinates. Null without at least 3 usable flights on at least 2 days.
 */
export function typicalRoute(tracks, origin, destination) {
  const usable = tracks.filter((t) => t.line.length >= 2);
  if (usable.length < 3 || new Set(usable.map((t) => t.day)).size < 2) return null;

  const sampled = usable.map((t) => resample(t.line));
  let best = 0, bestScore = Infinity;
  for (let i = 0; i < sampled.length; i++) {
    let score = 0;
    for (let j = 0; j < sampled.length; j++) if (i !== j) score += meanDistance(sampled[i], sampled[j]);
    if (score < bestScore) {bestScore = score; best = i;}
  }

  let tolerance = START_TOLERANCE_M;
  let line = simplify(usable[best].line, tolerance);
  while (line.length > MAX_POINTS) {
    tolerance *= 2;
    line = simplify(usable[best].line, tolerance);
  }
  line = [[origin[0], origin[1]], ...line.slice(1, -1), [destination[0], destination[1]]];
  return line;
}

/** A line as integers: the first point in hundredths of a degree, then each point's wrapped (lon, lat) difference. */
export function encodeRoute(line) {
  const out = [];
  let prevLon = 0, prevLat = 0;
  line.forEach((p, i) => {
    const lon = Math.round(p[0] * 100), lat = Math.round(p[1] * 100);
    if (i === 0) out.push(lon, lat);
    else out.push(wrapHundredths(lon - prevLon), lat - prevLat);
    prevLon = lon;
    prevLat = lat;
  });
  return out;
}

/** Each integer zigzagged, then written as base-32 digits, least significant first; bit 5 of a digit says another follows. */
export function encodeRouteText(encoded) {
  let out = '';
  for (const n of encoded) {
    let v = n >= 0 ? n * 2 : -n * 2 - 1;
    do {
      const digit = v % 32;
      v = Math.floor(v / 32);
      out += TEXT_DIGITS[digit + (v > 0 ? 32 : 0)];
    } while (v > 0);
  }
  return out;
}
