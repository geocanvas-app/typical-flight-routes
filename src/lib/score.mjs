/** Scoring helpers shared by both gates. Positions are [lon, lat]. */
import {inverse, routeProgress} from './geodesy.mjs';

/** Fractions of the great-circle distance at which a track and a library line are compared: 0.10, 0.15 ... 0.90. */
export const GRID = Array.from({length: 17}, (_, i) => 0.1 + 0.05 * i);
export const MIN_GRID_POINTS = 8;
export const MIN = 60_000;

export const dist = (a, b) => inverse(a, b).distanceM;
export const pathM = (ps) => ps.slice(1).reduce((s, p, i) => s + dist(ps[i], p), 0);

/** Signed cross-track from the leg's great circle at each grid fraction of its distance, null where the line has no point past it. */
export function crossAt(origin, destination, line, totalM) {
  const progress = line.map((p) => routeProgress(origin, destination, p));
  return GRID.map((g) => {
    const target = g * totalM;
    const i = progress.findIndex((p) => p.alongM >= target);
    if (i <= 0) return null;
    const a = progress[i - 1], b = progress[i], f = (target - a.alongM) / Math.max(1, b.alongM - a.alongM);
    return a.crossM + (b.crossM - a.crossM) * f;
  });
}
