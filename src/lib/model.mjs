/**
 * The calm-wind airborne-time model the gate scores against, and the legacy flight profile. Positions are [lon, lat].
 *
 * Model, stepped over the route in STEP_M steps along the origin to destination great circle: climb at 2,000 ft/min with
 * TAS rising linearly with height from the liftoff speed to cruise TAS, cruise at TAS, a descent path of 3 nm per 1,000 ft
 * flown at cruise TAS, and an approach allowance (APPROACH_MIN) for the slowdown of the descent, spread over the descent
 * and normalised so that a route from the takeoff gets the whole allowance. The gate runs it with no wind. Taxi-out is
 * 15 min before the first airborne sample.
 */
import {inverse, pointAlongRoute} from './geodesy.mjs';

export const STEP_M = 50_000, APPROACH_MIN = 8, DEFAULT_MACH = 0.83, DEFAULT_FL = 350;
export const TAXI_OUT_MIN = 15;
const MIN = 60_000;
const FT = 0.3048;
const CLIMB_MPS = (2000 * FT) / 60;
/** Ground metres per metre of height in the descent: 3 nm per 1,000 ft. */
export const GLIDE_M_PER_M = (3 * 1852) / (1000 * FT);
const LIFTOFF_TAS_MPS = 75;
const CLIMB_STEP_M = 5_000;

// ISA standard atmosphere, temperature only (troposphere to 11 km, isothermal above).
const T0 = 288.15, LAPSE = 0.0065, TROPOPAUSE_M = 11_000, T_STRAT = 216.65;
const GAMMA = 1.4, R_AIR = 287.05;
export const isaTemperatureK = (altM) => (altM <= TROPOPAUSE_M ? T0 - LAPSE * altM : T_STRAT);
export const tasForMach = (mach, altM) => mach * Math.sqrt(GAMMA * R_AIR * isaTemperatureK(altM));

const RAD = Math.PI / 180;
function alongCross(u, v, trackDeg) {
  const t = trackDeg * RAD;
  return {alongMps: u * Math.sin(t) + v * Math.cos(t), crossMps: u * Math.cos(t) - v * Math.sin(t)};
}
/** Ground speed along the course; null when the crosswind exceeds TAS, the headwind stops the aircraft, or an input is not a number. */
export function groundSpeedFor(tasMps, courseDeg, u, v) {
  const {alongMps, crossMps} = alongCross(u, v, courseDeg);
  if (!(Math.abs(crossMps) <= tasMps)) return null;
  const gs = alongMps + Math.sqrt(tasMps * tasMps - crossMps * crossMps);
  return gs > 0 ? gs : null;
}

/** The origin to destination great circle as a path: total length, a point and the course at an along distance. */
function greatCirclePath(origin, destination) {
  const totalM = inverse(origin, destination).distanceM;
  const pointAt = (alongM) => pointAlongRoute(origin, destination, alongM);
  const END_GUARD_M = 0.01;
  return {
    totalM, pointAt,
    courseAt: (alongM) => inverse(pointAt(Math.min(alongM, totalM - END_GUARD_M)), destination).azi1Deg,
  };
}

/** Height at `alongM` in a still-air climb: s(t) = v0 t + (tas - v0) t^2 / 2T. */
function climbHeightAt(alongM, cruiseAltM, tas) {
  const T = cruiseAltM / CLIMB_MPS;
  const a = Math.max(0, tas - LIFTOFF_TAS_MPS) / (2 * T);
  const t = a === 0 ? alongM / LIFTOFF_TAS_MPS : (-LIFTOFF_TAS_MPS + Math.sqrt(LIFTOFF_TAS_MPS ** 2 + 4 * a * alongM)) / (2 * a);
  return Math.min(cruiseAltM, CLIMB_MPS * t);
}

/** Share of the approach allowance still ahead with `r` metres to go on a descent of `descM`. */
function approachShare(r, descM, tas) {
  if (descM <= 0) return 0;
  const x = Math.min(1, r / descM);
  const k = tas / LIFTOFF_TAS_MPS - 1;
  if (k <= 0) return x;
  const extra = (f) => Math.log(1 + k * f) / k - f / (1 + k);
  return extra(x) / extra(1);
}

/** Metres before the runway where the descent starts: the full glide from cruise height, or where the climb and glide meet on a route too short to cruise. */
export function descentStartM(totalM, cruiseAltM, tas) {
  const full = cruiseAltM * GLIDE_M_PER_M;
  if (totalM >= full && climbHeightAt(totalM - full, cruiseAltM, tas) >= cruiseAltM) return full;
  let lo = 0;
  let hi = totalM;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (climbHeightAt(mid, cruiseAltM, tas) < (totalM - mid) / GLIDE_M_PER_M) lo = mid;
    else hi = mid;
  }
  return totalM - (lo + hi) / 2;
}

/**
 * Time to fly the whole great circle from the origin (alongM 0). `timing` is {cruiseTasMps, approachMin, routeStretch};
 * the route stretch multiplies each step's time (extra path flown, not a slower climb). `wind(lonLat, altM, tMs)` returns
 * {u, v} in m/s or null for calm.
 */
export function estimateArrival(o) {
  const tas = o.timing?.cruiseTasMps ?? tasForMach(DEFAULT_MACH, o.cruiseAltM);
  const path = greatCirclePath(o.origin, o.destination);
  const stretch = o.timing?.routeStretch ?? 1;
  const totalM = path.totalM;
  const descM = Math.min(totalM, o.cruiseAltM * GLIDE_M_PER_M);
  const startM = 0;

  let s = startM;
  let tMs = o.fromMs;
  let climbAlt = climbHeightAt(startM, o.cruiseAltM, tas);
  let usedCalmWind = false;
  while (totalM - s > 1) {
    const climbing = climbAlt < o.cruiseAltM;
    const ds = Math.min(climbing ? CLIMB_STEP_M : STEP_M, totalM - s);
    const mid = s + ds / 2;
    const descentCap = (totalM - mid) / GLIDE_M_PER_M;
    const rampTas = (h) => LIFTOFF_TAS_MPS + (tas - LIFTOFF_TAS_MPS) * Math.min(1, h / o.cruiseAltM);
    const inClimb = climbing && climbAlt < descentCap;
    const climbMid = climbing ? Math.min(o.cruiseAltM, climbAlt + (CLIMB_MPS * ds) / 2 / rampTas(climbAlt)) : o.cruiseAltM;
    const altMid = Math.min(climbMid, descentCap);
    const air = inClimb ? rampTas(altMid) : tas;

    const p = path.pointAt(mid);
    const course = path.courseAt(mid);
    const w = o.wind(p, altMid, tMs + (ds / 2 / air) * 1000);
    if (!w) usedCalmWind = true;
    const gs = groundSpeedFor(air, course, w?.u ?? 0, w?.v ?? 0) ?? air;
    const dt = ds / gs;
    const flownS = dt * stretch;

    s += ds;
    tMs += flownS * 1000;
    if (climbing) climbAlt = Math.min(o.cruiseAltM, climbAlt + CLIMB_MPS * dt);
  }

  const share = approachShare(totalM - startM, descM, tas);
  const topM = descentStartM(totalM, o.cruiseAltM, tas);
  const fullM = o.cruiseAltM * GLIDE_M_PER_M;
  const topShare = approachShare(topM, fullM, tas);
  const timeShare = topShare > 0 ? approachShare(Math.min(totalM - startM, topM), fullM, tas) / topShare : share;
  const remainingAirborneMs = tMs - o.fromMs + (o.timing?.approachMin ?? APPROACH_MIN) * MIN * timeShare;
  return {remainingAirborneMs, usedCalmWind};
}

/** Airborne time of the whole flight, taking off TAXI_OUT_MIN after `departureMs`. */
export function modelledAirborne(o) {
  const r = estimateArrival({
    fromMs: o.departureMs + TAXI_OUT_MIN * MIN, origin: o.origin, destination: o.destination,
    cruiseAltM: o.cruiseAltM, wind: o.wind, timing: o.timing,
  });
  return {airborneMs: r.remainingAirborneMs, usedCalmWind: r.usedCalmWind};
}

/** The legacy flight profile: FL350 at Mach 0.83, an 8 min approach allowance, no route stretch. */
export function legacyProfile() {
  const cruiseAltM = DEFAULT_FL * 100 * FT;
  return {cruiseAltM, cruiseTasMps: tasForMach(DEFAULT_MACH, cruiseAltM), approachMin: APPROACH_MIN, routeStretch: 1};
}
