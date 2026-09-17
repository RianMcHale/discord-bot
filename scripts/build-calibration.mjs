// Turns the collected sample into a calibration artifact (spec §7.1, §7.4).
//
// Two things come out of this:
//
//   1. Role baselines — the numbers BASELINE in roles.js currently *guesses*.
//      jungleCs14: 88, goldPerMin: 460, turretDmgPerMin: 220/280, ccScore: 55,
//      healShield: 700 were all my estimates, flagged as such in the comments.
//      This replaces them with measured medians.
//
//   2. Median and MAD per role per metric, which is what §5.5's robust z-score
//      needs. Emitted whether or not the sample is yet large enough to use, so
//      the sample size is visible rather than assumed.
//
// Medians and MADs rather than means and SDs, per §5.5: one 45-minute stomp
// should not move the scale.
//
//   node scripts/build-calibration.mjs

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const ROWS = path.join(ROOT, 'data', 'calibration', 'rows.ndjson');
const OUT = path.join(ROOT, 'config', 'calibration.json');

// The spec (§7.2 option 3) says ship provisional and say so until the window has
// enough games. This is the line below which a role's numbers are advisory.
const MIN_ROWS_PER_ROLE = 150;

// Patch window (spec §7.3). A snowballed sample reaches back through a player's
// whole match history, so it spans patches the current game no longer resembles —
// the first pull returned rows from 16.2 through 16.17. Pooling those produces a
// baseline for a game nobody is playing.
//
// PATCH_MIN is the oldest patch admitted. Set it to the oldest patch since the
// last meta break; the spec's §13 `meta_breaks` is the same idea, and note its
// values are written as 26.x where Riot actually reports 16.x — Riot numbers
// patches by season, not calendar year.
const PATCH_MIN = process.env.PATCH_MIN || '16.13';

const patchRank = (p) => {
  const [maj, min] = String(p || '').split('.').map(Number);
  return Number.isFinite(maj) && Number.isFinite(min) ? maj * 100 + min : -1;
};

const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

// Every field the rubrics compare against a baseline, and how it is used.
const METRICS = [
  'dmgShare', 'tankShare', 'kp', 'lateKp', 'killShare',
  'csPerMin', 'goldPerMin', 'visionPerMin', 'wDeathsPerMin', 'epicShare',
  'jungleCs14', 'turretDmgPerMin', 'ccScore', 'healShield',
  'gold14', 'xp14', 'cs14', 'platesEarly', 'platesLate',
  // Lane differentials. Not baselines — their median is 0 by construction, since
  // every row's counterpart carries the negation. They are here for their *p90*,
  // which is what a curve has to be scaled against: the hand-set lane scale put
  // an ordinary 90th-percentile top lane at 92 and an ordinary support lane at
  // 77, so the same quality of game scored differently by role.
  'goldDiff14', 'xpDiff14', 'postGoldPerMin', 'teamLaneGoldDiff14', 'goldShare', 'damagePerGoldShare', 'killPerDamageShare',
  // Jungle only, and null for everyone else — the per-role pass drops nulls, so
  // these simply produce a JUNGLE bar and nothing elsewhere.
  'gankTakedowns', 'lanesLeftHanging', 'alliesUnanswered'
];

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Median absolute deviation, scaled to be comparable with a standard deviation. */
const mad = (xs, med) => {
  if (!xs.length || med === null) return null;
  const d = xs.map((x) => Math.abs(x - med));
  const m = median(d);
  return m === null ? null : m * 1.4826;
};

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};

if (!fs.existsSync(ROWS)) {
  console.error(`No sample at ${ROWS}. Run scripts/calibration-pull.mjs first.`);
  process.exit(1);
}

const allRows = fs
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
  .filter(Boolean);

// Gold earned after laning ends, per minute. Derived rather than collected, so
// it needs no second pull: total gold is goldPerMin x minutes, and everything
// before the bench minute is already in gold14.
for (const r of allRows) {
  const after = (r.minutes ?? 0) - 14;
  r.postGoldPerMin =
    after >= 3 && typeof r.goldPerMin === 'number' && typeof r.gold14 === 'number'
      ? +((r.goldPerMin * r.minutes - r.gold14) / after).toFixed(1)
      : null;
}

// Damage share divided by gold share — spec §4.1's anti-snowball metric, the
// third thing F4 asks for. Derived rather than collected: total gold is
// goldPerMin x minutes, and the team total is the five rows on that side.
{
  const byMatch = new Map();
  for (const r of allRows) {
    if (!byMatch.has(r.matchId)) byMatch.set(r.matchId, []);
    byMatch.get(r.matchId).push(r);
  }
  for (const [, rs] of byMatch) {
    if (rs.length !== 10) continue;
    for (const win of [true, false]) {
      const side = rs.filter((r) => r.win === win);
      if (side.length !== 5) continue;
      const teamGold = side.reduce((s, r) => s + r.goldPerMin * r.minutes, 0);
      for (const r of side) {
        r.goldShare = teamGold > 0 ? +((r.goldPerMin * r.minutes) / teamGold).toFixed(4) : null;
        r.damagePerGoldShare =
          r.dmgShare != null && r.goldShare > 0 ? +(r.dmgShare / r.goldShare).toFixed(4) : null;
        // Did the damage convert? Spec 12.3's conflicting-metrics requirement:
        // damage share alone is farmable by poking a tank in a lost teamfight.
        r.killPerDamageShare =
          r.killShare != null && r.dmgShare > 0 ? +(r.killShare / r.dmgShare).toFixed(4) : null;
      }
    }
  }
}

// How far ahead or behind a team's four lanes collectively are at 14. The jungle
// rubric grades tempo against this, and its scale was hand-set the same way the
// individual lane scales were. Stored on every row of the match so it comes out
// of the per-role pass like any other metric; the jungler's row is the one read.
{
  const byMatch = new Map();
  for (const r of allRows) {
    if (!byMatch.has(r.matchId)) byMatch.set(r.matchId, []);
    byMatch.get(r.matchId).push(r);
  }
  for (const [, rs] of byMatch) {
    if (rs.length !== 10) continue;
    const laneGold = (win) =>
      rs.filter((r) => r.win === win && r.role !== 'JUNGLE').reduce((s, r) => s + (r.gold14 || 0), 0);
    const diff = laneGold(true) - laneGold(false);
    for (const r of rs) r.teamLaneGoldDiff14 = r.win ? diff : -diff;
  }
}

const minRank = patchRank(PATCH_MIN);
const rows = allRows.filter((r) => patchRank(r.patch) >= minRank);
const droppedForPatch = allRows.length - rows.length;

const matches = new Set(rows.map((r) => r.matchId));
const patches = {};
for (const r of rows) patches[r.patch] = (patches[r.patch] || 0) + 1;
const queues = {};
for (const r of rows) queues[r.queueId] = (queues[r.queueId] || 0) + 1;

// Population statistics that are not per-role. TYPICAL_TEAM_AVG_KP in roles.js
// was hand-set to 0.55; measured it is 0.467, and the 15% error inflated every
// player's participation score because the bar is rescaled by it.
const byMatch = new Map();
for (const r of rows) {
  if (!byMatch.has(r.matchId)) byMatch.set(r.matchId, []);
  byMatch.get(r.matchId).push(r);
}
const teamAvgKps = [];
for (const [, rs] of byMatch) {
  if (rs.length !== 10) continue;
  for (const win of [true, false]) {
    const side = rs.filter((r) => r.win === win);
    if (side.length === 5) teamAvgKps.push(side.reduce((s, r) => s + (r.kp || 0), 0) / 5);
  }
}

const byRole = {};
for (const role of ROLES) {
  const mine = rows.filter((r) => r.role === role);
  const stats = {};
  for (const m of METRICS) {
    const xs = mine.map((r) => r[m]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    const med = median(xs);
    stats[m] = {
      n: xs.length,
      median: med === null ? null : +med.toFixed(4),
      mad: mad(xs, med) === null ? null : +mad(xs, med).toFixed(4),
      p10: quantile(xs, 0.1) === null ? null : +quantile(xs, 0.1).toFixed(4),
      p90: quantile(xs, 0.9) === null ? null : +quantile(xs, 0.9).toFixed(4)
    };
  }
  byRole[role] = {
    rows: mine.length,
    provisional: mine.length < MIN_ROWS_PER_ROLE,
    metrics: stats
  };
}

const artifact = {
  generatedAt: new Date().toISOString(),
  sample: {
    matches: matches.size,
    participantRows: rows.length,
    patches,
    queues,
    minRowsPerRole: MIN_ROWS_PER_ROLE,
    patchWindow: { min: PATCH_MIN, rowsDroppedAsTooOld: droppedForPatch }
  },
  // Any role below the floor is advisory: the numbers are emitted so they can be
  // inspected, not so they can be trusted.
  globals: {
    teamAvgKp: median(teamAvgKps) === null ? null : +median(teamAvgKps).toFixed(4),
    teamSides: teamAvgKps.length
  },
  provisional: ROLES.some((r) => byRole[r].provisional),
  roles: byRole
};

// The version is a content hash, so a score can name exactly which calibration
// produced it and loading a mismatched one is detectable (§7.4).
artifact.calibrationVersion = crypto
  .createHash('sha256')
  .update(JSON.stringify({ roles: artifact.roles, globals: artifact.globals }))
  .digest('hex')
  .slice(0, 12);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));

console.log(`Wrote config/calibration.json  (version ${artifact.calibrationVersion})`);
console.log(`  ${matches.size} matches, ${rows.length} participant rows (patch >= ${PATCH_MIN}; dropped ${droppedForPatch} older rows)`);
console.log(`  patches: ${Object.entries(patches).map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`  provisional: ${artifact.provisional}`);
console.log('');
console.log('  role      rows   csPerMin  goldPerMin  visionPerMin  dmgShare');
for (const role of ROLES) {
  const s = byRole[role].metrics;
  const f = (m) => (s[m].median === null ? '   —' : String(s[m].median).padStart(7));
  console.log(
    `  ${role.padEnd(9)} ${String(byRole[role].rows).padStart(4)}   ${f('csPerMin')}   ${f('goldPerMin')}      ${f('visionPerMin')}   ${f('dmgShare')}` +
      (byRole[role].provisional ? '   (provisional)' : '')
  );
}
