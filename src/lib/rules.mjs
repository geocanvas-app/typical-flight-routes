/** The pass or fail rules of the two gates. Pure, no I/O. Every rule needs finite inputs, so a missing or NaN value fails closed. */

export const MIN_COVERAGE = 0.5;
export const MAX_ZIPPED_BYTES = 3 * 1024 * 1024;

/**
 * The first gate: measures {coverage, gcSidewaysKm, libSidewaysKm, gcLengthPct, libLengthPct, activeTimeMin, libTimeMin, zippedBytes}.
 * Returns {go, failed}.
 */
export function typicalRoutesVerdict(m) {
  const rules = [
    ['coverage', [m.coverage], m.coverage >= MIN_COVERAGE],
    ['sideways', [m.libSidewaysKm, m.gcSidewaysKm], m.libSidewaysKm <= 0.5 * m.gcSidewaysKm],
    ['length', [m.libLengthPct, m.gcLengthPct], m.libLengthPct <= 0.5 * m.gcLengthPct],
    ['time', [m.libTimeMin, m.activeTimeMin], m.libTimeMin <= m.activeTimeMin],
    ['size', [m.zippedBytes], m.zippedBytes <= MAX_ZIPPED_BYTES],
  ];
  const failed = rules.filter(([, values, pass]) => !values.every(Number.isFinite) || !pass).map(([name]) => name);
  return {go: failed.length === 0, failed};
}

// The world confirmation.
export const MIN_GROUP_LEGS = 100;
export const MIN_GROUP_PAIRS = 10;
export const MIN_PAIR_SHARE = 2 / 3;

/** A group with fewer than 100 scored legs on 10 airport pairs is 'insufficient evidence', whatever its numbers; else 'confirmed' or 'not confirmed'. */
export function worldGroupClass(g) {
  if (!(Number.isFinite(g.scoredLegs) && Number.isFinite(g.scoredPairs)) || g.scoredLegs < MIN_GROUP_LEGS || g.scoredPairs < MIN_GROUP_PAIRS) {
    return 'insufficient evidence';
  }
  const values = [g.coverage, g.gcSidewaysKm, g.libSidewaysKm, g.gcLengthPct, g.libLengthPct, g.pairsBetterShare];
  const passes = g.coverage >= MIN_COVERAGE && g.libSidewaysKm <= 0.5 * g.gcSidewaysKm && g.libLengthPct <= 0.5 * g.gcLengthPct
    && g.pairsBetterShare >= MIN_PAIR_SHARE;
  return values.every(Number.isFinite) && passes ? 'confirmed' : 'not confirmed';
}

/** The longest contiguous run of confirmed bands, by distance span; the shorter-distance run on a tie. `bands` ({lowKm, highKm, cls}) are in distance order. */
export function confirmedRange(bands) {
  let best = null;
  let start = -1;
  for (let i = 0; i <= bands.length; i++) {
    if (i < bands.length && bands[i].cls === 'confirmed') {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      const run = {lowKm: bands[start].lowKm, highKm: bands[i - 1].highKm};
      if (!best || run.highKm - run.lowKm > best.highKm - best.lowKm) best = run;
      start = -1;
    }
  }
  return best;
}

/**
 * The range gate (`go`), the confirmed range and the world flag. `go` needs a confirmed pooled group, the library's grounded
 * time no worse than the active model's, a zipped index within 3 MiB, and a matcher check with at most 2 % wrong. With no ends
 * judged the matcher check fails. Without `go` no range is confirmed and `worldConfirmed` is false.
 */
export function worldDecisions(input) {
  const {matcherRight: right, matcherWrong: wrong} = input;
  const countsOk = [right, wrong].every((n) => Number.isFinite(n) && n >= 0) && right + wrong > 0;
  const rules = [
    ['pooled', [], input.pooledClass === 'confirmed'],
    ['time', [input.libTimeMin, input.activeTimeMin], input.libTimeMin <= input.activeTimeMin],
    ['size', [input.zippedBytes], input.zippedBytes <= MAX_ZIPPED_BYTES],
    ['matcher', [], countsOk && wrong * 50 <= right + wrong],
  ];
  const failed = rules.filter(([, values, pass]) => !values.every(Number.isFinite) || !pass).map(([name]) => name);
  const go = failed.length === 0;
  return {go, failed, confirmedRange: go ? confirmedRange(input.bands) : null, worldConfirmed: go && input.restOfWorldClass === 'confirmed'};
}
