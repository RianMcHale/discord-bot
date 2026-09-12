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
  // Post-15 participation is a different distribution from overall KP - it runs
  // 7-22% higher, and by a different factor per role - so it needs its own bar
  // rather than borrowing the overall one.
  lateKp: 'lateKp',
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
  // Damage share over gold share — what you did with what you got (§4.1).
  // `goldShare` is the denominator of the bar it is graded against, not a score
  // in its own right: taking more of the team's gold is neither good nor bad.
  damagePerGoldShare: 'damagePerGoldShare',
  // Kills per unit of damage share — did the damage decide anything (§12.3).
  killPerDamageShare: 'killPerDamageShare',
  goldShare: 'goldShare',
  // The lane component has never had an absolute anchor — spec F5 applied to the
  // heaviest component in three rubrics. These are what give it one.
  gold14: 'gold14',
  xp14: 'xp14'
};

// Shares of one team's total. The five role baselines have to sum to 1 by
// construction, and five independent medians do not — skew pulls them to about
// 0.93. Renormalising keeps the property the metric depends on.
const NORMALISED_SHARES = ['killShare'];

// Bars where the median is the wrong statistic.
//
// A support's CC and heal/shield output is bimodal by champion class: an Alistar
// heals nothing, a Soraka lands almost no CC. The rubric grades whichever axis
// they specialised in, so the bar has to be what a good practitioner of that
// axis does — not the median across every support, most of whom did not choose
// it. Measured, the median support heals 114/min while the 90th percentile heals
// 551. Using 114 as the enchanter bar would score every Soraka near 100, which
// is precisely the matchup-dependence bug fixed earlier.
const SPECIALIST_BARS = { ccScore: 'p90', healShield: 'p90' };

// Where a role's 90th-percentile game should land on a 0-100 curve.
//
// Not 100. p90 is an ordinary good game — one player in ten has one — and the
// scale has to keep telling them apart from the one game in two hundred that was
// genuinely exceptional. Deaths, the one curve that was already scaled sanely,
// puts p90 at 72 and p10 at 32 across all five roles; this makes that deliberate
// rather than lucky.
//
// fromDiff is 50 + 50·tanh(1.1·d/full), so landing p90 on 72 means
// full = 1.1·p90 / atanh(0.44) = 2.329·p90.
const P90_TARGET = 72;
const SCALE_K = 1.1 / Math.atanh((P90_TARGET - 50) / 50);

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

/**
 * A measured population statistic, or the given fallback.
 *
 * Used for constants that are not per-role. `teamAvgKp` is the one that mattered:
 * the participation bar is rescaled by how this particular game spread its
 * kills, against a typical figure that was hand-set to 0.55. Measured across 976
 * team-sides it is 0.467, and the 15% error shrank the bar for everyone, so
 * every player's participation score was inflated.
 */
export function globalStat(name, fallback) {
  const v = read()?.globals?.[name];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** The measured stats for one role's metric, or null if it isn't usable. */
function roleMetric(role, metricId) {
  const measured = read()?.roles?.[role];
  if (!measured || measured.provisional) return null;
  return measured.metrics?.[metricId] ?? null;
}

/**
 * `full` for a signed difference (gold@14, xp@14) on a `fromDiff` curve, scaled
 * so this role's 90th-percentile game scores 72.
 *
 * A single hand-set number cannot do this, because the roles do not have the
 * same spread: the 90th-percentile top lane is 2022g ahead and the
 * 90th-percentile support lane is 974g ahead. Grading both on `full = 1800` is
 * what made the same quality of lane score 92 as a top laner and 77 as a
 * support — a 15-point gap in the heaviest component of either rubric, decided
 * by role rather than by play.
 */
export function diffScale(role, metricId, fallback) {
  const p90 = roleMetric(role, metricId)?.p90;
  return typeof p90 === 'number' && Number.isFinite(p90) && p90 > 0 ? SCALE_K * p90 : fallback;
}

/**
 * `full` for a ratio-to-baseline on a `versusShare` curve, scaled the same way.
 * Expressed relative to the median, since that is what the ratio is against.
 */
export function ratioScale(role, metricId, fallback) {
  const stat = roleMetric(role, metricId);
  if (!stat) return fallback;
  const { median, p90 } = stat;
  if (!(typeof median === 'number' && median > 0 && typeof p90 === 'number' && p90 > median)) return fallback;
  return SCALE_K * (p90 / median - 1);
}

/**
 * Whether a role's measured distribution leaves any room above its own bar.
 *
 * Shares have a ceiling of 1, and one of them sits on it: the median jungler is
 * present for 100% of their team's epic objectives — 795 of 915 in the sample
 * are at exactly 1.0. Grading that against a bar of 1.0 can only ever return 50,
 * so the absolute term stops carrying information and starts diluting the
 * head-to-head term it is blended with. Being on every objective is table stakes
 * for a jungler; what separates them is how many their team got, which other
 * parts of the rubric already measure.
 *
 * Returns true when uncalibrated, since a hand-set bar is a guess rather than a
 * ceiling.
 */
export function hasHeadroom(role, metricId) {
  const s = roleMetric(role, metricId);
  if (!s) return true;
  return typeof s.median === 'number' && typeof s.p90 === 'number' && s.p90 > s.median;
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
      if (!stat) continue;
      const value = stat[SPECIALIST_BARS[metricId] ?? 'median'];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) merged[field] = value;
    }
    out[role] = merged;
  }

  // Renormalise the share metrics across the roles that actually got measured.
  for (const field of NORMALISED_SHARES) {
    const roles = Object.keys(out).filter((r) => r !== 'UNKNOWN' && cal.roles[r] && !cal.roles[r].provisional);
    if (roles.length !== 5) continue; // a partial set cannot be made to sum to 1
    const total = roles.reduce((s, r) => s + (out[r][field] || 0), 0);
    // Not rounded. Five shares rounded to 4dp sum to 0.9999, and the whole point
    // of this pass is that they sum to 1 — a partition that does not partition
    // silently shifts every role's bar.
    if (total > 0) for (const r of roles) out[r][field] = out[r][field] / total;
  }

  return out;
}
