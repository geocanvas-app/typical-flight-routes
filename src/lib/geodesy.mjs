// Route geometry on the WGS84 ellipsoid: geodesic distance and azimuths, and progress along an origin to destination
// geodesic with a signed cross-track offset. Positions are [lon, lat] in degrees.
import geographiclib from 'geographiclib-geodesic';

const {Geodesic} = geographiclib.Geodesic ? geographiclib : geographiclib.default;
const geod = Geodesic.WGS84;

function normLon(lon) {
  const l = ((((lon + 180) % 360) + 360) % 360) - 180;
  return l === -180 && lon > 0 ? 180 : l;
}

export function inverse(a, b) {
  const r = geod.Inverse(a[1], a[0], b[1], b[0]);
  return {distanceM: r.s12, azi1Deg: r.azi1, azi2Deg: r.azi2};
}

export function direct(from, aziDeg, distanceM) {
  const r = geod.Direct(from[1], from[0], aziDeg, distanceM);
  return [normLon(r.lon2), r.lat2];
}

export function pointAlongRoute(origin, destination, alongM) {
  return direct(origin, inverse(origin, destination).azi1Deg, alongM);
}

const rad = (d) => (d * Math.PI) / 180;

export function routeProgress(origin, destination, position) {
  const route = inverse(origin, destination);
  const totalM = route.distanceM;
  const at = (s) => {
    const r = geod.Direct(origin[1], origin[0], route.azi1Deg, s);
    return {pt: [r.lon2, r.lat2], azi: r.azi2};
  };

  // Newton-style walk of the foot point until the foot-to-position azimuth is perpendicular.
  let s = 0;
  for (let i = 0; i < 30; i++) {
    const {pt, azi} = at(s);
    const f = inverse(pt, position);
    const delta = f.distanceM * Math.cos(rad(f.azi1Deg - azi));
    s += delta;
    if (Math.abs(delta) < 1e-4) break;
  }
  const sc = Math.min(Math.max(s, 0), totalM);
  const {pt, azi} = at(sc);
  const f = inverse(pt, position);
  const signed = f.distanceM * Math.sin(rad(f.azi1Deg - azi)); // + is right of the course
  return {totalM, alongM: sc, remainingM: totalM - sc, fraction: totalM > 0 ? sc / totalM : 0, crossM: signed};
}
