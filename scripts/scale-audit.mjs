// Runs every scoring curve over the real sample and reports what it produces
// (spec §11.3, the fairness gate).
//
// The parity test proves the five rubrics agree on what an *average* game is
// worth. It says nothing about spread, and spread is what actually decides the
// bench: the lowest composite sits out, so a role whose components swing wider
// gets benched more often at identical skill. That is an unfair benching
// produced entirely by a constant nobody chose.
//
// This is the missing half of the check. Every metric the rubrics grade is in
// data/calibration/rows.ndjson, and each row can be paired with the player who
// actually played the same role on the other team — so the head-to-head half of
// every blend is real, not simulated.
//
// What to look for:
//
//   * median far from 50   — the bar is wrong for that role
//   * p10/p90 far from the target band — the curve is too sharp or too flat
//   * spread differing by role — the fairness bug this exists to catch
//
// Costs nothing: reads the sample already on disk, makes no API calls.
//
//   node scripts/scale-audit.mjs

import { ROLES, TARGET, SPREAD_TOLERANCE, PATCH_MIN, q, paired, CURVES, hasSample, SAMPLE_PATH } from './lib/scale-curves.mjs';

if (!hasSample) {
  console.error(`No sample at ${SAMPLE_PATH}. Run scripts/calibration-pull.mjs first.`);
  process.exit(1);
}

const pad = (s, n) => String(s).padStart(n);
let failures = 0;
const summary = [];

console.log(`Scale audit — ${paired.length} paired player-games, patch >= ${PATCH_MIN}\n`);
console.log(`Target band for the middle 80% of games: p10 >= ${TARGET.p10}, p90 <= ${TARGET.p90}`);
console.log(`Roles must agree on spread to within ${SPREAD_TOLERANCE} points.\n`);

for (const [name, fn] of Object.entries(CURVES)) {
  const spreads = [];
  const lines = [];
  for (const role of ROLES) {
    const xs = paired
      .filter((r) => r.role === role)
      .map(fn)
      .filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (xs.length < 50) {
      lines.push(`    ${role.padEnd(9)} — too few rows (${xs.length})`);
      continue;
    }
    const p10 = q(xs, 0.1);
    const med = q(xs, 0.5);
    const p90 = q(xs, 0.9);
    spreads.push(p90 - p10);
    const flags = [];
    if (Math.abs(med - 50) > 6) flags.push('bar off');
    if (p10 < TARGET.p10 - 8 || p90 > TARGET.p90 + 8) flags.push('over-spread');
    if (p90 - p10 < 18) flags.push('flat');
    lines.push(
      `    ${role.padEnd(9)} ${pad(p10.toFixed(1), 6)} ${pad(med.toFixed(1), 6)} ${pad(p90.toFixed(1), 6)}   ${pad(
        (p90 - p10).toFixed(1),
        6
      )}   ${flags.join(', ')}`
    );
  }
  const gap = spreads.length ? Math.max(...spreads) - Math.min(...spreads) : 0;
  const uneven = gap > SPREAD_TOLERANCE;
  if (uneven) failures++;
  summary.push({ name, gap, uneven });
  console.log(`  ${name}${uneven ? `   ⚠ roles disagree on spread by ${gap.toFixed(1)} points` : ''}`);
  console.log(`    role         p10    med    p90   spread`);
  for (const l of lines) console.log(l);
  console.log('');
}

console.log('Summary — how unevenly each curve treats the five roles:');
for (const s of [...summary].sort((a, b) => b.gap - a.gap)) {
  console.log(`  ${s.name.padEnd(22)} ${pad(s.gap.toFixed(1), 6)}${s.uneven ? '  ⚠' : ''}`);
}
console.log(`\n${failures} curve(s) outside the ${SPREAD_TOLERANCE}-point fairness tolerance.`);
