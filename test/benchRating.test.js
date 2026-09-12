// Finding F6: /worst ranked six people by a raw five-game mean. With a per-game
// SD near 15 the standard error on that mean is about 6.7 points, so a
// three-point gap is noise — and the player benched most often would be the one
// with the highest variance, not the lowest mean.
//
// These pin the four things that fix it: recency weighting, effective sample
// size, empirical-Bayes shrinkage, and a refusal to call a tie a verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateShrinkage,
  recencyWeights,
  intervalOverlap,
  benchVerdict,
  isBenchQuality
} from '../src/benchRating.js';

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Recency weighting and effective sample size
// ---------------------------------------------------------------------------

test('a game today counts for more than the same game last month', () => {
  const now = Date.now();
  const { weights } = recencyWeights([now, now - 30 * DAY], now);
  assert.ok(weights[0] > weights[1]);
  // 0.97/day halves at about 23 days, so a month-old game is worth under half.
  assert.ok(weights[1] < 0.5 * weights[0], `a 30-day-old game should be worth under half (${weights[1].toFixed(3)})`);
});

test('effective sample size counts weighted games, not games', () => {
  const now = Date.now();
  // Six games all played today really are six games.
  const fresh = recencyWeights(Array(6).fill(now), now);
  assert.ok(Math.abs(fresh.nEff - 6) < 1e-9);

  // Six where five are ancient are worth barely more than one.
  const stale = recencyWeights([now, ...Array(5).fill(now - 200 * DAY)], now);
  assert.ok(stale.nEff < 2.5, `mostly-old games must not count as six (${stale.nEff.toFixed(2)})`);
  assert.ok(stale.nEff >= 1);
});

test('a squad that has not played for a year still has a rating', () => {
  // 0.97 ** 20000 is exactly zero in float64, so weighting against the clock
  // directly gives every game a weight of zero, a mean of NaN and an effective
  // sample size of zero — for games that are all simply old. The weights are
  // anchored on the newest game instead, which changes no result because both
  // the mean and n_eff are invariant to a common factor.
  const now = Date.now();
  const ancient = recencyWeights([now - 8000 * 24 * 3600e3, now - 8001 * 24 * 3600e3], now);
  assert.ok(ancient.weights.every((w) => w > 0), 'old games must not weigh literally nothing');
  assert.ok(ancient.nEff > 1.9, `two equally old games are still two games (${ancient.nEff})`);
});

test('anchoring the weights changes no relative weighting', () => {
  // Same set of ages, evaluated a year apart. The ratio between any two weights
  // depends only on the gap between them, so the answer must not move.
  const now = Date.now();
  const ages = [0, 3, 9, 21];
  const a = recencyWeights(ages.map((d) => now - d * DAY), now);
  const b = recencyWeights(ages.map((d) => now - (d + 365) * DAY), now);
  assert.ok(Math.abs(a.nEff - b.nEff) < 1e-9, 'the same shape of history is the same sample size');
  for (let i = 0; i < ages.length; i++) {
    assert.ok(Math.abs(a.weights[i] - b.weights[i]) < 1e-9);
  }
});

test('effective sample size never exceeds the games that produced it', () => {
  const now = Date.now();
  for (const ages of [[0], [0, 5, 40], [0, 1, 2, 3, 4, 5, 90, 200]]) {
    const { nEff } = recencyWeights(ages.map((d) => now - d * DAY), now);
    assert.ok(nEff <= ages.length + 1e-9, `${nEff} from ${ages.length} games`);
  }
});

// ---------------------------------------------------------------------------
// Empirical-Bayes shrinkage
// ---------------------------------------------------------------------------

test('players who genuinely differ are shrunk less than players who do not', () => {
  // Five players who are plainly different, each consistent with themselves.
  const distinct = estimateShrinkage([
    [70, 72, 68, 71],
    [60, 62, 58, 61],
    [50, 52, 48, 51],
    [40, 42, 38, 41],
    [30, 32, 28, 31]
  ]);
  // Five players who are the same, each bouncing around a lot.
  const noise = estimateShrinkage([
    [70, 30, 65, 35],
    [35, 68, 32, 66],
    [67, 33, 69, 31],
    [31, 70, 34, 64],
    [66, 34, 30, 71]
  ]);

  assert.ok(distinct.estimable, 'real differences must be detected');
  assert.ok(distinct.k < noise.k, `a real spread should shrink less (${distinct.k.toFixed(1)} vs ${noise.k.toFixed(1)})`);
  assert.ok(distinct.sigmaBetween > distinct.sigmaWithin, 'players differ more than their own games do');
});

test('when nobody is distinguishable it says so instead of ranking anyway', () => {
  // Identical distributions. There is no real between-player variance here, and
  // the honest output is "cannot tell", not a leaderboard.
  const same = estimateShrinkage([
    [60, 40, 55, 45],
    [45, 55, 40, 60],
    [55, 45, 60, 40],
    [40, 60, 45, 55]
  ]);
  assert.equal(same.estimable, false);
  assert.equal(same.sigmaBetween, 0);
  assert.ok(Number.isFinite(same.k), 'k must stay a number even when the estimate degenerates');
});

test('too little history falls back rather than inventing a variance', () => {
  const thin = estimateShrinkage([[50], [60]]);
  assert.equal(thin.estimable, false);
  assert.equal(thin.sigmaWithin, 15, "the spec's assumed SD, until there is enough to measure");
});

// ---------------------------------------------------------------------------
// Intervals and the verdict
// ---------------------------------------------------------------------------

test('overlap is measured against the narrower interval', () => {
  assert.equal(intervalOverlap({ low: 0, high: 10 }, { low: 20, high: 30 }), 0);
  assert.equal(intervalOverlap({ low: 0, high: 10 }, { low: 0, high: 10 }), 1);
  // A wide interval swallowing a narrow one is total overlap, not partial —
  // dividing by the wider one would call that pair distinguishable.
  assert.equal(intervalOverlap({ low: 0, high: 100 }, { low: 40, high: 50 }), 1);
  assert.equal(intervalOverlap({ low: 0, high: 10 }, { low: 5, high: 15 }), 0.5);
});

const at = (rating, half) => ({ rating, low: rating - half, high: rating + half, discordId: `p${rating}` });

test('two players inside each other’s error bars are not a bench call', () => {
  const verdict = benchVerdict([at(46, 7), at(49, 7)]);
  assert.equal(verdict.decisive, false, '3 points apart with ±7 bars is a coin flip');
  assert.equal(verdict.tied.length, 1);
});

test('a real gap still produces a verdict', () => {
  const verdict = benchVerdict([at(38, 4), at(56, 4)]);
  assert.equal(verdict.decisive, true);
  assert.equal(verdict.worst.rating, 38);
  assert.equal(verdict.tied.length, 0);
});

test('a three-way tie names all three rather than picking one', () => {
  const verdict = benchVerdict([at(45, 8), at(47, 8), at(48, 8), at(70, 8)]);
  assert.equal(verdict.decisive, false);
  assert.equal(verdict.tied.length, 2, 'both of the indistinguishable pair, not just the runner-up');
  assert.ok(!verdict.tied.some((p) => p.rating === 70), 'a player who is clearly fine is not part of the tie');
});

test('the same gap is decisive on more games and not on fewer', () => {
  // The whole point of F6 in one assertion: the gap did not change, the
  // confidence in it did.
  const thin = benchVerdict([at(44, 9), at(50, 9)]);
  const thick = benchVerdict([at(44, 2.5), at(50, 2.5)]);
  assert.equal(thin.decisive, false);
  assert.equal(thick.decisive, true);
});

test('one eligible player is a verdict by default, not a tie', () => {
  const verdict = benchVerdict([at(44, 9)]);
  assert.equal(verdict.decisive, true);
});

test('nobody eligible is refused rather than guessed', () => {
  const verdict = benchVerdict([]);
  assert.equal(verdict.decisive, false);
  assert.equal(verdict.worst, null);
});

// ---------------------------------------------------------------------------
// Which games may decide a bench
// ---------------------------------------------------------------------------

const game = (over = {}) => ({
  dataQuality: 'full',
  scores: { u1: { composite: 50, dataQuality: 'full', roleConfidence: 'HIGH', counterpartValid: true, ...over } }
});

test('a game scored without a timeline cannot bench anyone', () => {
  // Lane state, jungle pressure, death context and objective control all drop
  // out without a timeline. The score is real but it is not the same measurement.
  assert.equal(isBenchQuality(game(), 'u1'), true);
  assert.equal(isBenchQuality(game({ dataQuality: 'partial' }), 'u1'), false);
});

test('a game where the role was a guess cannot bench anyone', () => {
  // The failure is silent: a Sett support compared against a jungler produces a
  // plausible number, not an error.
  assert.equal(isBenchQuality(game({ roleConfidence: 'LOW' }), 'u1'), false);
  assert.equal(isBenchQuality(game({ counterpartValid: false }), 'u1'), false);
});

test('a player who was not in the game is not scored zero for it', () => {
  assert.equal(isBenchQuality(game(), 'someone-else'), false);
  assert.equal(isBenchQuality(game({ composite: null }), 'u1'), false);
});

// ---------------------------------------------------------------------------
// Lobby integrity (spec §12.1)
//
// A player who leaves distorts all ten scores, not just the one opposite them.
// Their four team-mates split a team total between four rather than five, so
// every share on that side inflates; the other five get a free lane and free
// gold. The numbers are measuring the absence.
// ---------------------------------------------------------------------------

test('a game somebody left cannot bench anyone', () => {
  assert.equal(isBenchQuality(game({ lobbyIntact: true }), 'u1'), true);
  assert.equal(isBenchQuality(game({ lobbyIntact: false }), 'u1'), false);
});

test('a game Riot called off early cannot bench anyone', () => {
  // An early surrender is a 4v5 by definition — it is the option a team gets
  // *because* somebody did not connect.
  assert.equal(isBenchQuality(game({ earlySurrender: true }), 'u1'), false);
  assert.equal(isBenchQuality(game({ earlySurrender: false }), 'u1'), true);
});

test('games stored before the check existed still count', () => {
  // Neither field is present on older rows. Treating "unknown" as "broken" would
  // silently empty the board of every game played before today.
  const old = game();
  delete old.scores.u1.lobbyIntact;
  delete old.scores.u1.earlySurrender;
  assert.equal(isBenchQuality(old, 'u1'), true);
});
