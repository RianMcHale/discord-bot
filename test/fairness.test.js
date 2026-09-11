// The fairness gate (spec §11.3).
//
// parity.test.js proves the five rubrics agree on what an *average* game is
// worth. That is only half the property. The bench goes to the lowest composite,
// so a role whose components swing wider gets benched more often at identical
// skill — an unfair benching produced by a constant nobody chose rather than by
// anyone's play.
//
// This runs every scoring curve over the real sample and checks that the five
// roles land in the same band. It found eight curves out of tolerance when first
// written, the worst by 87 points:
//
//   * the lane curve put an ordinary 90th-percentile top lane at 92 and the same
//     quality of support lane at 77, because one hand-set scale was applied to
//     five distributions of different width;
//   * the participation, damage-share and kill-share curves had the same defect;
//   * the jungler's epic-share bar was 1.0 — the metric's own ceiling — so that
//     axis could only ever return exactly 50.
//
// The sample is gitignored, so this skips rather than fails without it. That is
// deliberate: it means a fresh clone still passes `npm test`, and it means this
// check is only as current as the last calibration pull. Regenerate with
// `npm run calibration-pull && npm run build-calibration`, inspect with
// `npm run scale-audit`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, TARGET, SPREAD_TOLERANCE, q, paired, CURVES, hasSample } from '../scripts/lib/scale-curves.mjs';

/** p10/median/p90 of one curve for one role, or null if the sample is too thin. */
function distribution(fn, role) {
  const xs = paired
    .filter((r) => r.role === role)
    .map(fn)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (xs.length < 50) return null;
  return { p10: q(xs, 0.1), median: q(xs, 0.5), p90: q(xs, 0.9), n: xs.length };
}

test('every curve treats the five roles alike', { skip: !hasSample && 'no calibration sample on disk' }, () => {
  const offenders = [];
  for (const [name, fn] of Object.entries(CURVES)) {
    const spreads = ROLES.map((role) => distribution(fn, role))
      .filter(Boolean)
      .map((d) => d.p90 - d.p10);
    if (spreads.length < 2) continue;
    const gap = Math.max(...spreads) - Math.min(...spreads);
    if (gap > SPREAD_TOLERANCE) offenders.push(`${name} (${gap.toFixed(1)} points)`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these curves swing wider for some roles than others, which decides benchings by role:\n  ${offenders.join('\n  ')}`
  );
});

test('every curve is centred on par', { skip: !hasSample && 'no calibration sample on disk' }, () => {
  // 50 has to mean "you did your job" for every role on every metric, or the
  // composites are not comparable and neither is the bench.
  const offenders = [];
  for (const [name, fn] of Object.entries(CURVES)) {
    for (const role of ROLES) {
      const d = distribution(fn, role);
      if (d && Math.abs(d.median - 50) > 6) {
        offenders.push(`${name}/${role} sits at ${d.median.toFixed(1)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `bars that the median player does not actually meet:\n  ${offenders.join('\n  ')}`);
});

test('no curve is so sharp that an ordinary game reads as exceptional', {
  skip: !hasSample && 'no calibration sample on disk'
}, () => {
  // One player in ten is at p90. If that scores 92, the scale has nothing left
  // to say about the one game in two hundred that genuinely was exceptional —
  // and the component stops being able to rank the players it is there to rank.
  const offenders = [];
  for (const [name, fn] of Object.entries(CURVES)) {
    for (const role of ROLES) {
      const d = distribution(fn, role);
      if (!d) continue;
      if (d.p90 > TARGET.p90 + 8) offenders.push(`${name}/${role} puts p90 at ${d.p90.toFixed(1)}`);
      if (d.p10 < TARGET.p10 - 8) offenders.push(`${name}/${role} puts p10 at ${d.p10.toFixed(1)}`);
    }
  }
  assert.deepEqual(offenders, [], `curves too sharp for the spread they grade:\n  ${offenders.join('\n  ')}`);
});
