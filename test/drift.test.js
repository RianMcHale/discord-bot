// Noticing when the calibration stops fitting the game (spec §7.5).
//
// The role bars were measured on 16.13–16.17 and Riot patches every fortnight.
// A patch that buffs marksmen makes every ADC score above 50 against a bar that
// has not moved, and nothing about the scores would look any less authoritative.
import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { patchOf, patchRank, isCalibrationStale, patchStatus, driftReport, calibratedPatches } from '../src/drift.js';

const DAY = 24 * 60 * 60 * 1000;
const CAL = { min: '16.13', max: '16.17', list: ['16.13', '16.14', '16.15', '16.16', '16.17'] };
const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

/** Runs `fn` with META_BREAKS set, restoring it afterwards. */
function withBreaks(breaks, fn) {
  const before = config.metaBreaks;
  config.metaBreaks = breaks;
  try {
    return fn();
  } finally {
    config.metaBreaks = before;
  }
}

// Deterministic spread, so the drift tests are not flaky.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * `games` games, each with one opponent per role. `shift` moves a role's scores
 * (or every role's, with `all`), around a spread like the model really produces.
 */
function opponentGames(count, { shift = {}, all = 0, sd = 16, seed = 7 } = {}) {
  const rand = seeded(seed);
  const normal = () => {
    const u = Math.max(rand(), 1e-9);
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    matchId: `D${i}`,
    playedAt: now - (i % 25) * DAY,
    patch: '16.17',
    enemy: ROLES.map((role) => ({
      role,
      champion: 'X',
      composite: 50 + all + (shift[role] ?? 0) + normal() * sd
    }))
  }));
}

// --- patches -----------------------------------------------------------------

test('patches are read the way Riot reports them', () => {
  assert.equal(patchOf('16.17.123.4567'), '16.17');
  assert.equal(patchOf('garbage'), null);
  assert.equal(patchOf(undefined), null);
});

test('16.9 comes before 16.10', () => {
  // Compared as strings, "16.10" sorts before "16.9", and a patch-ordering bug
  // here would call every double-digit patch older than the calibration.
  assert.ok(patchRank('16.9') < patchRank('16.10'));
  assert.ok(patchRank('16.17') < patchRank('17.1'), 'and a season rollover is newer, not a hundred patches back');
});

test('an ordinary newer patch does not stop a game benching anyone', () => {
  // Most patches are balance tweaks. Treating every fortnightly patch as a break
  // would stop the bench working half the time, which is worse than a slightly
  // stale bar.
  withBreaks([], () => {
    assert.equal(isCalibrationStale('16.19', CAL), false);
  });
});

test('a game past a declared meta break the calibration predates is stale', () => {
  withBreaks(['17.1'], () => {
    assert.equal(isCalibrationStale('17.1', CAL), true);
    assert.equal(isCalibrationStale('17.3', CAL), true, 'and everything after it');
    assert.equal(isCalibrationStale('16.19', CAL), false, 'but not what came before the break');
  });
});

test('a break the calibration already covers stops nothing', () => {
  // Once the sample is rebuilt on the new patch, the games count again — which is
  // the whole point of recalibrating.
  withBreaks(['16.15'], () => {
    assert.equal(isCalibrationStale('16.17', CAL), false);
  });
  const rebuilt = { ...CAL, max: '17.2' };
  withBreaks(['17.1'], () => {
    assert.equal(isCalibrationStale('17.2', rebuilt), false);
  });
});

test('patch status says how far past the calibration the games are', () => {
  const games = ['16.17', '16.18', '16.19', '16.19'].map((patch, i) => ({ matchId: `P${i}`, patch }));
  withBreaks([], () => {
    const s = patchStatus(games, CAL);
    assert.equal(s.newest, '16.19');
    assert.equal(s.ahead, 2, 'two distinct patches played past 16.17');
    assert.equal(s.crossedBreak, null);
  });
  withBreaks(['16.19'], () => {
    const s = patchStatus(games, CAL);
    assert.equal(s.crossedBreak, '16.19');
    assert.equal(s.staleGames, 2);
  });
});

test('games stored before the patch was recorded are counted, not guessed', () => {
  const s = patchStatus([{ matchId: 'A' }, { matchId: 'B', patch: '16.17' }], CAL);
  assert.equal(s.gamesWithoutPatch, 1);
});

test('the real calibration on disk is read for its patches', () => {
  const cal = calibratedPatches();
  if (!cal) return; // no artifact in this checkout
  assert.ok(patchRank(cal.min) <= patchRank(cal.max));
  assert.ok(cal.list.length >= 1);
});

// --- drift -------------------------------------------------------------------

test('a role that moves against the others is flagged', () => {
  // A patch buffs marksmen: ADCs start scoring 8 above everyone else.
  const report = driftReport(opponentGames(260, { shift: { BOTTOM: 8 } }));
  const adc = report.roles.find((r) => r.role === 'BOTTOM');
  assert.equal(adc.verdict, 'drifted', `ADC at ${adc.drift?.toFixed(1)} should be caught`);
  assert.ok(adc.drift > 3);
  assert.deepEqual(
    report.drifted.map((r) => r.role),
    ['BOTTOM'],
    'and only the role that actually moved'
  );
});

test('a strong squad scoring above 50 everywhere is not drift', () => {
  // The spec's check — any role median outside 50 ± 3 — would fire here. For a
  // premade playing above its rating that is the normal state of affairs, not a
  // stale calibration. Every role shifting together is exactly what the relative
  // comparison is built to cancel.
  const report = driftReport(opponentGames(260, { all: 7 }));
  assert.equal(report.drifted.length, 0, `nothing drifted, the whole lobby just skews (${report.centre?.toFixed(1)})`);
  for (const r of report.roles) assert.notEqual(r.verdict, 'drifted');
});

test('it will not call a role in step on too few games to tell', () => {
  // Standard error on a median of thirty scores is over three points, so "in
  // step" off that would be the same overclaim finding F6 was about.
  const report = driftReport(opponentGames(30, { shift: { BOTTOM: 8 } }));
  for (const r of report.roles) {
    assert.notEqual(r.verdict, 'in-step', `${r.role} confirmed in step on ${r.n} scores`);
  }
});

test('the same sample size never gets contradictory labels', () => {
  // "Too few to tell" is about how many scores there are, not about how noisy
  // one role's draw happened to be — otherwise sixty Top scores read as too few
  // beside sixty Mid scores marked fine.
  const report = driftReport(opponentGames(60));
  const thin = report.roles.filter((r) => r.verdict === 'thin');
  assert.ok(thin.length === 0 || thin.length === 5, 'every role has the same number of scores here');
});

test('in step is only claimed once a meaningful drift has been ruled out', () => {
  const report = driftReport(opponentGames(2000, { seed: 3 }));
  const inStep = report.roles.filter((r) => r.verdict === 'in-step');
  assert.ok(inStep.length > 0, 'a large sample with no real drift should confirm some roles in step');
  for (const r of inStep) assert.ok(r.bound <= 3, `${r.role} claimed in step while it could be ${r.bound.toFixed(1)} off`);
});

test('it says how many games it would need', () => {
  // "Not enough yet" is only useful with a number attached.
  const report = driftReport(opponentGames(10));
  assert.ok(report.gamesNeeded > 40, `a 3-point drift through a 16-point spread needs a real sample (${report.gamesNeeded})`);
  assert.ok(report.gamesNeeded < 400, 'but not an absurd one');
});

test('small wobble inside the tolerance is not drift', () => {
  const report = driftReport(opponentGames(300, { shift: { MIDDLE: 1.5, TOP: -1 } }));
  assert.equal(report.drifted.length, 0);
});

test('only games inside the window count', () => {
  const old = opponentGames(260, { shift: { BOTTOM: 12 } }).map((g) => ({ ...g, playedAt: g.playedAt - 400 * DAY }));
  const report = driftReport(old, { days: 30 });
  assert.equal(report.games, 0, 'a drift from last year is not a drift now');
});

test('games with no opponent line are skipped rather than breaking it', () => {
  const report = driftReport([{ matchId: 'X', playedAt: Date.now() }]);
  assert.equal(report.games, 0);
  assert.equal(report.centre, null);
});

test('it does not cry wolf, and still catches a real drift', () => {
  // The detector's actual error rates, measured over many seeded samples rather
  // than asserted from one. A false alarm has a real cost — it tells the squad
  // not to trust a bench call that is fine, and prompts a recalibration that
  // spends a thousand API calls — so the bar is essentially none on harmless
  // wobble, with large drifts still caught reliably.
  const SEEDS = 60;
  let falseAlarms = 0;
  let caught = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    if (driftReport(opponentGames(300, { shift: { MIDDLE: 1.5 }, seed })).drifted.length) falseAlarms++;
    if (driftReport(opponentGames(300, { shift: { BOTTOM: 8 }, seed })).drifted.some((r) => r.role === 'BOTTOM')) caught++;
  }
  assert.ok(falseAlarms <= 1, `${falseAlarms} false alarms in ${SEEDS} samples of harmless wobble`);
  assert.ok(caught >= SEEDS * 0.85, `an 8-point drift was caught in only ${caught} of ${SEEDS}`);
});
