// Loads the measured role baselines, if there are any (spec §7.1, §7.4).
//
// The BASELINE table in roles.js was hand-set. Several of its numbers turned out
// to be wrong by half when measured — the objectives bar for top and mid was
// more than twice the real median, the ADC damage bar a fifth above it. This
// replaces a role's numbers with measured medians once that role's sample is
// large enough to be worth trusting, and leaves the hand-set value in place
// until then.
//
// Three rules, all of them about not making things quietly worse:
//
//   * A role below the sample floor keeps its hand-set numbers. Swapping a bad
//     guess for a noisy measurement is not an improvement.
//   * A metric with no measurement keeps its hand-set number rather than
//     becoming undefined.
//   * The calibration version travels with every score, so a number can always
//     be traced to the sample that produced it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CALIBRATION_PATH =
  process.env.CALIBRATION_PATH || path.join(__dirname, '..', '..', 'config', 'calibration.json');

/** Calibration metric id -> BASELINE field it replaces. */
const FIELD_MAP = {
  dmgShare: 'dmgShare',
  tankShare: 'tankShare',
  kp: 'kp',
  killShare: 'killShare',
  csPerMin: 'csPerMin',
  goldPerMin: 'goldPerMin',
  visionPerMin: 'visionPerMin',
  wDeathsPerMin: 'wDeathsPerMin',
  epicShare: 'epicShare',
  jungleCs14: 'jungleCs14',
  turretDmgPerMin: 'turretDmgPerMin',
  ccScore: 'ccScore',
  healShield: 'healShield',
  // The lane component has never had an absolute anchor — spec F5 applied to the
  // heaviest component in three rubrics. These are what give it one.
  gold14: 'gold14',
  xp14: 'xp14'
};

// Shares of one team's total. The five role baselines have to sum to 1 by
// construction, and five independent medians do not — skew pulls them to about
// 0.93. Renormalising keeps the property the metric depends on.
const NORMALISED_SHARES = ['killShare'];

let cached;

function read() {
  if (cached !== undefined) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf-8'));
  } catch {
    cached = null; // no calibration yet is a normal state, not an error
  }
  return cached;
}

/** Test seam: forget the cached artifact so a different one can be loaded. */
export function resetCalibration() {
  cached = undefined;
}

/** The version string a score should carry, or null when running uncalibrated. */
export function calibrationVersion() {
  const cal = read();
  return cal?.calibrationVersion ?? null;
}

/** Which roles are running on measured numbers rather than hand-set ones. */
export function calibratedRoles() {
  const cal = read();
  if (!cal?.roles) return [];
  return Object.entries(cal.roles)
    .filter(([, r]) => !r.provisional)
    .map(([role]) => role);
}

/**
 * Returns BASELINE with measured medians folded in where the sample supports it.
 * Given the hand-set table, never mutates it.
 */
export function applyCalibration(baseline) {
  const cal = read();
  if (!cal?.roles) return baseline;

  const out = {};
  for (const [role, hand] of Object.entries(baseline)) {
    const measured = cal.roles[role];
    if (!measured || measured.provisional) {
      out[role] = { ...hand };
      continue;
    }
    const merged = { ...hand };
    for (const [metricId, field] of Object.entries(FIELD_MAP)) {
      const stat = measured.metrics?.[metricId];
      if (stat && typeof stat.median === 'number' && Number.isFinite(stat.median) && stat.median > 0) {
        merged[field] = stat.median;
      }
    }
    out[role] = merged;
  }

  // Renormalise the share metrics across the roles that actually got measured.
  for (const field of NORMALISED_SHARES) {
    const roles = Object.keys(out).filter((r) => r !== 'UNKNOWN' && cal.roles[r] && !cal.roles[r].provisional);
    if (roles.length !== 5) continue; // a partial set cannot be made to sum to 1
    const total = roles.reduce((s, r) => s + (out[r][field] || 0), 0);
    if (total > 0) for (const r of roles) out[r][field] = +(out[r][field] / total).toFixed(4);
  }

  return out;
}
