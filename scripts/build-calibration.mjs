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

const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

// Every field the rubrics compare against a baseline, and how it is used.
const METRICS = [
  'dmgShare', 'tankShare', 'kp', 'lateKp', 'killShare',
  'csPerMin', 'goldPerMin', 'visionPerMin', 'wDeathsPerMin', 'epicShare',
  'jungleCs14', 'turretDmgPerMin', 'ccScore', 'healShield',
  'gold14', 'xp14', 'cs14', 'platesEarly', 'platesLate'
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

const rows = fs
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

const matches = new Set(rows.map((r) => r.matchId));
const patches = {};
for (const r of rows) patches[r.patch] = (patches[r.patch] || 0) + 1;
const queues = {};
for (const r of rows) queues[r.queueId] = (queues[r.queueId] || 0) + 1;

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
    minRowsPerRole: MIN_ROWS_PER_ROLE
  },
  // Any role below the floor is advisory: the numbers are emitted so they can be
  // inspected, not so they can be trusted.
  provisional: ROLES.some((r) => byRole[r].provisional),
  roles: byRole
};

// The version is a content hash, so a score can name exactly which calibration
// produced it and loading a mismatched one is detectable (§7.4).
artifact.calibrationVersion = crypto
  .createHash('sha256')
  .update(JSON.stringify(artifact.roles))
  .digest('hex')
  .slice(0, 12);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));

console.log(`Wrote config/calibration.json  (version ${artifact.calibrationVersion})`);
console.log(`  ${matches.size} matches, ${rows.length} participant rows`);
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
