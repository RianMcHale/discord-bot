// The curve library the fairness gate runs over, shared by scripts/scale-audit.mjs
// (which prints it) and test/fairness.test.js (which enforces it).
//
// A caveat worth knowing: these entries MIRROR how roles.js grades each metric,
// they do not call it. The sample on disk is derived rows, not raw matches, so
// scoreMatch cannot be run over it. That is enough to catch a mis-scaled curve,
// which is what this exists for, but it does not stay in sync by itself — change
// a curve in roles.js and the mirror here has to change with it.
//
// Anything needing timeline context the rows do not carry (jungle pressure,
// death tags, roam paths) is left out rather than approximated.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { versus, versusShare, fromDiff, blend, weightedMean, clamp } from '../../src/scoring/scale.js';
import { BASELINE, expectedDmgShare } from '../../src/scoring/roles.js';
import { globalStat, diffScale, ratioScale, hasHeadroom } from '../../src/scoring/calibration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROWS = path.join(__dirname, '..', '..', 'data', 'calibration', 'rows.ndjson');
const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

// The band a healthy curve should put the middle 80% of real games into.
//
// Not 0-100: p10 and p90 are ordinary games. One player in ten is at each, and
// "one top laner in ten had a 92-point lane" is not a claim the model should be
// making. Leaving headroom above p90 is what keeps a genuinely exceptional game
// distinguishable from a merely good one.
const TARGET = { p10: 30, p90: 72 };
const SPREAD_TOLERANCE = 12; // max p10..p90 difference between the widest and narrowest role

const PATCH_MIN = process.env.PATCH_MIN || '16.13';
const patchRank = (p) => {
  const [maj, min] = String(p || '').split('.').map(Number);
  return Number.isFinite(maj) && Number.isFinite(min) ? maj * 100 + min : -1;
};

const q = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};

// The sample is gitignored (large, regenerable, tied to one API key), so its
// absence is a normal state on a fresh clone rather than an error. Callers check
// hasSample: the script says how to generate it, the test skips.
export const hasSample = fs.existsSync(ROWS);
export const SAMPLE_PATH = ROWS;

const rows = !hasSample
  ? []
  : fs
  .readFileSync(ROWS, 'utf-8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .filter((r) => patchRank(r.patch) >= patchRank(PATCH_MIN));

// Pair each row with the player who played the same role on the other team, and
// attach the team context the rubrics rescale by.
const byMatch = new Map();
for (const r of rows) {
  if (!byMatch.has(r.matchId)) byMatch.set(r.matchId, []);
  byMatch.get(r.matchId).push(r);
}
const paired = [];
for (const [, rs] of byMatch) {
  if (rs.length !== 10) continue;
  for (const r of rs) {
    const opp = rs.find((o) => o.role === r.role && o.win !== r.win);
    const side = rs.filter((o) => o.win === r.win);
    if (side.length !== 5) continue;
    paired.push({ ...r, opp: opp || null, teamAvgKp: side.reduce((s, o) => s + (o.kp || 0), 0) / 5 });
  }
}

const TYPICAL_TEAM_AVG_KP = globalStat('teamAvgKp', 0.55);
const ctxOf = (r) => ({ minutes: r.minutes });
const spreadOf = (r) => (r.teamAvgKp ? clamp(r.teamAvgKp / TYPICAL_TEAM_AVG_KP, 0.6, 1.4) : 1);

// Each entry mirrors how the live rubric grades that metric. Anything needing
// timeline context the rows do not carry (jungle pressure, death tags, roam
// paths) is left out rather than approximated — an approximated curve would
// report a spread the model does not actually produce.
const laneGold = (r) =>
  blend(
    fromDiff(r.goldDiff14, diffScale(r.role, 'goldDiff14', 4680)),
    versusShare(r.gold14, BASELINE[r.role].gold14, { full: ratioScale(r.role, 'gold14', 0.5) })
  );
const laneXp = (r) =>
  blend(
    fromDiff(r.xpDiff14, diffScale(r.role, 'xpDiff14', 3640)),
    versusShare(r.xp14, BASELINE[r.role].xp14, { full: ratioScale(r.role, 'xp14', 0.38) })
  );

const CURVES = {
  'lane gold': laneGold,
  'lane xp': laneXp,
  'lane combined': (r) =>
    weightedMean([
      { score: laneGold(r), weight: 0.6 },
      { score: laneXp(r), weight: 0.4 }
    ]),
  deaths: (r) =>
    blend(
      r.opp?.wDeathsPerMin == null ? null : versus(r.opp.wDeathsPerMin, r.wDeathsPerMin, { prior: 0.12, gain: 1.3 }),
      versus(BASELINE[r.role].wDeathsPerMin, r.wDeathsPerMin, { prior: 0.12, gain: 1.3 })
    ),
  'damage share': (r) =>
    r.dmgShare == null
      ? null
      : versusShare(r.dmgShare, expectedDmgShare({ role: r.role }, ctxOf(r), BASELINE[r.role]), { full: ratioScale(r.role, 'dmgShare', 0.75) }),
  // Damage share over gold share, against a bar derived the same way the rubric
  // derives it — expected damage share divided by the role's gold share — so it
  // inherits the game-length slope.
  conversion: (r) => {
    const bar = BASELINE[r.role].goldShare > 0
      ? expectedDmgShare({ role: r.role }, ctxOf(r), BASELINE[r.role]) / BASELINE[r.role].goldShare
      : null;
    return r.damagePerGoldShare == null || bar == null
      ? null
      : versusShare(r.damagePerGoldShare, bar, { full: ratioScale(r.role, 'damagePerGoldShare', 0.8) });
  },
  'tank share': (r) => (r.tankShare == null ? null : versusShare(r.tankShare, BASELINE[r.role].tankShare, { full: ratioScale(r.role, 'tankShare', 1.0) })),
  'kill share': (r) =>
    r.killShare == null
      ? null
      : blend(
          r.opp?.killShare == null ? null : versus(r.killShare, r.opp.killShare, { prior: 0.06, gain: 1.25 }),
          versusShare(r.killShare, BASELINE[r.role].killShare, { full: ratioScale(r.role, 'killShare', 1.0) })
        ),
  'participation (kp)': (r) => versusShare(r.kp, BASELINE[r.role].kp * spreadOf(r), { full: ratioScale(r.role, 'kp', 0.6) }),
  'participation (late)': (r) =>
    r.lateKp == null ? null : versusShare(r.lateKp, BASELINE[r.role].lateKp * spreadOf(r), { full: ratioScale(r.role, 'lateKp', 0.6) }),
  vision: (r) =>
    blend(
      r.opp?.visionPerMin == null ? null : versus(r.visionPerMin, r.opp.visionPerMin, { prior: 0.2 }),
      versus(r.visionPerMin, BASELINE[r.role].visionPerMin, { prior: 0.2 })
    ),
  'epic share': (r) =>
    r.epicShare == null || !hasHeadroom(r.role, 'epicShare')
      ? null
      : versusShare(r.epicShare, BASELINE[r.role].epicShare, { full: ratioScale(r.role, 'epicShare', 0.9) }),
  'cs/min': (r) =>
    blend(
      r.opp?.csPerMin == null ? null : versus(r.csPerMin, r.opp.csPerMin, { prior: 1.5, gain: 1.3 }),
      versus(r.csPerMin, BASELINE[r.role].csPerMin, { prior: 1.5, gain: 1.3 })
    )
};

export { ROLES, TARGET, SPREAD_TOLERANCE, PATCH_MIN, q, paired, CURVES };
