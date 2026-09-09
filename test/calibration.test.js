// The BASELINE table was hand-set, and measuring it showed several numbers were
// wrong by half. This is the machinery that replaces a guess with a measurement —
// and, more importantly, the rules that stop it making things worse.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lolbench-cal-'));
const file = path.join(dir, 'calibration.json');
process.env.CALIBRATION_PATH = file;

const { applyCalibration, calibrationVersion, calibratedRoles, resetCalibration } = await import(
  '../src/scoring/calibration.js'
);

const HAND = {
  TOP: { dmgShare: 0.21, csPerMin: 6.4, epicShare: 0.45, killShare: 0.2 },
  JUNGLE: { dmgShare: 0.18, csPerMin: 5.6, epicShare: 0.75, killShare: 0.19 },
  MIDDLE: { dmgShare: 0.26, csPerMin: 7.0, epicShare: 0.5, killShare: 0.24 },
  BOTTOM: { dmgShare: 0.28, csPerMin: 7.6, epicShare: 0.55, killShare: 0.26 },
  UTILITY: { dmgShare: 0.09, csPerMin: 1.2, epicShare: 0.4, killShare: 0.11 },
  UNKNOWN: { dmgShare: 0.2, csPerMin: 5.5, epicShare: 0.5, killShare: 0.2 }
};

/** Writes an artifact and clears the loader's cache. */
function withCalibration(roles, version = 'testver') {
  const metricise = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { median: v, n: 500 }]));
  fs.writeFileSync(
    file,
    JSON.stringify({
      calibrationVersion: version,
      roles: Object.fromEntries(
        Object.entries(roles).map(([role, r]) => [
          role,
          { rows: r.rows ?? 500, provisional: r.provisional ?? false, metrics: metricise(r.metrics) }
        ])
      )
    })
  );
  resetCalibration();
}

test('a measured median replaces the hand-set guess', () => {
  withCalibration({
    TOP: { metrics: { epicShare: 0.2, dmgShare: 0.2295 } },
    JUNGLE: { metrics: {} },
    MIDDLE: { metrics: {} },
    BOTTOM: { metrics: {} },
    UTILITY: { metrics: {} }
  });
  const b = applyCalibration(HAND);
  assert.equal(b.TOP.epicShare, 0.2, 'the objectives bar was measured at less than half the guess');
  assert.equal(b.TOP.dmgShare, 0.2295);
});

test('a provisional role keeps its hand-set numbers', () => {
  // Swapping a bad guess for a noisy measurement is not an improvement.
  withCalibration({
    TOP: { provisional: true, rows: 40, metrics: { epicShare: 0.05 } },
    JUNGLE: { metrics: {} },
    MIDDLE: { metrics: {} },
    BOTTOM: { metrics: {} },
    UTILITY: { metrics: {} }
  });
  assert.equal(applyCalibration(HAND).TOP.epicShare, 0.45, 'thin samples must not move the bar');
  assert.ok(!calibratedRoles().includes('TOP'));
});

test('a metric with no measurement keeps its hand-set value', () => {
  withCalibration({
    TOP: { metrics: { dmgShare: 0.23 } },
    JUNGLE: { metrics: {} },
    MIDDLE: { metrics: {} },
    BOTTOM: { metrics: {} },
    UTILITY: { metrics: {} }
  });
  const b = applyCalibration(HAND);
  assert.equal(b.TOP.dmgShare, 0.23, 'measured');
  assert.equal(b.TOP.csPerMin, 6.4, 'unmeasured, so unchanged — never undefined');
});

test('a zero or nonsense median is ignored rather than applied', () => {
  withCalibration({
    TOP: { metrics: { csPerMin: 0, epicShare: -1 } },
    JUNGLE: { metrics: {} },
    MIDDLE: { metrics: {} },
    BOTTOM: { metrics: {} },
    UTILITY: { metrics: {} }
  });
  const b = applyCalibration(HAND);
  assert.equal(b.csPerMin, undefined);
  assert.equal(b.TOP.csPerMin, 6.4, 'a zero bar would make every comparison meaningless');
  assert.equal(b.TOP.epicShare, 0.45);
});

test('kill-share baselines are renormalised to sum to one', () => {
  // They are shares of a single team's kills, so the five must sum to 1 by
  // construction. Five independent medians sum to about 0.93 because of skew.
  withCalibration({
    TOP: { metrics: { killShare: 0.1883 } },
    JUNGLE: { metrics: { killShare: 0.2205 } },
    MIDDLE: { metrics: { killShare: 0.2297 } },
    BOTTOM: { metrics: { killShare: 0.2222 } },
    UTILITY: { metrics: { killShare: 0.0706 } }
  });
  const b = applyCalibration(HAND);
  const total = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'].reduce((s, r) => s + b[r].killShare, 0);
  assert.ok(Math.abs(total - 1) < 0.002, `shares of one team's kills must sum to 1, got ${total}`);
  assert.ok(b.JUNGLE.killShare > b.TOP.killShare, 'and the measured ordering survives');
});

test('a partial set of measured roles is not renormalised', () => {
  // Making three roles sum to 1 would be worse than leaving them alone.
  withCalibration({
    TOP: { metrics: { killShare: 0.1883 } },
    JUNGLE: { metrics: { killShare: 0.2205 } },
    MIDDLE: { provisional: true, metrics: {} },
    BOTTOM: { provisional: true, metrics: {} },
    UTILITY: { provisional: true, metrics: {} }
  });
  const b = applyCalibration(HAND);
  assert.equal(b.TOP.killShare, 0.1883, 'left as measured');
  assert.equal(b.MIDDLE.killShare, 0.24, 'left as guessed');
});

test('no calibration file at all is a normal state', () => {
  fs.rmSync(file, { force: true });
  resetCalibration();
  assert.deepEqual(applyCalibration(HAND), HAND, 'the hand-set table stands alone');
  assert.equal(calibrationVersion(), null);
  assert.deepEqual(calibratedRoles(), []);
});

test('an unreadable calibration file does not take the bot down', () => {
  fs.writeFileSync(file, 'not json');
  resetCalibration();
  assert.doesNotThrow(() => applyCalibration(HAND));
  assert.equal(calibrationVersion(), null);
});

test('the version is exposed so a score can name what produced it', () => {
  withCalibration({ TOP: { metrics: { dmgShare: 0.23 } }, JUNGLE: { metrics: {} }, MIDDLE: { metrics: {} }, BOTTOM: { metrics: {} }, UTILITY: { metrics: {} } }, 'abc123');
  assert.equal(calibrationVersion(), 'abc123');
  assert.deepEqual(calibratedRoles().sort(), ['BOTTOM', 'JUNGLE', 'MIDDLE', 'TOP', 'UTILITY']);
});

test('applying a calibration never mutates the table it was given', () => {
  withCalibration({ TOP: { metrics: { dmgShare: 0.99 } }, JUNGLE: { metrics: {} }, MIDDLE: { metrics: {} }, BOTTOM: { metrics: {} }, UTILITY: { metrics: {} } });
  const before = JSON.parse(JSON.stringify(HAND));
  applyCalibration(HAND);
  assert.deepEqual(HAND, before);
});

// /calibration exists so the group can see what the numbers are measured
// against, and how much of that is measured rather than guessed. A bot whose
// authority rests on nobody checking is the thing this project replaced.
test('/calibration says plainly when it is running on guesses', async () => {
  fs.rmSync(file, { force: true });
  resetCalibration();
  const cmd = await import(`../src/commands/calibration.js?u=${Date.now()}`);
  let out = null;
  await cmd.execute({ options: {}, async reply(p) { out = p; } });
  const j = out.embeds[0].toJSON();
  assert.match(j.description, /hand-set baselines/);
  assert.match(j.description, /estimate, not a measurement/);
});

test('/calibration names the version and which roles are measured', async () => {
  withCalibration(
    {
      TOP: { metrics: { dmgShare: 0.2295, epicShare: 0.2 } },
      JUNGLE: { metrics: { dmgShare: 0.1593 } },
      MIDDLE: { metrics: { dmgShare: 0.2328 } },
      BOTTOM: { metrics: { dmgShare: 0.2299 } },
      UTILITY: { provisional: true, rows: 40, metrics: {} }
    },
    'ab12cd34'
  );
  const cmd = await import(`../src/commands/calibration.js?u=${Date.now()}`);
  let out = null;
  await cmd.execute({ options: {}, async reply(p) { out = p; } });
  const j = out.embeds[0].toJSON();
  assert.match(j.description, /ab12cd34/);
  assert.match(j.description, /\*\*4\/5\*\* roles/);
  assert.match(j.description, /Support still on estimates/);
});
