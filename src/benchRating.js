// The bench decision, done as statistics rather than as a sorted list of means
// (spec §8, finding F6).
//
// The finding is blunt: with about five games a session and a per-game score SD
// near 15, the standard error on a five-game mean is about 6.7 points. Benching
// on a three-point difference in rolling average is benching on noise — and the
// person benched most often will be, in expectation, the one with the highest
// *variance* rather than the lowest mean. That is a real unfairness with a real
// victim, and it is invisible because the output looks like a number.
//
// Four things fix it, and all four are here:
//
//   1. Recency weighting, so last week counts less than last night without a
//      hard window boundary that makes a rating jump when an old game falls out.
//   2. Effective sample size. Six recency-weighted games are not six games.
//   3. Empirical-Bayes shrinkage toward the player's own long-run mean — the
//      "empirical" part being that the strength of the shrinkage is estimated
//      from how much the squad's players actually differ, not guessed.
//   4. A confidence interval, and a refusal to name anyone whose interval
//      overlaps the next player's. "The bottom two are indistinguishable" is
//      usually the honest answer and it settles more arguments than it starts.

import { db } from './storage.js';
import { config } from './config.js';
import { aggregateComponents } from './rollingStats.js';

// Per day. 0.97 halves a game's weight after about 23 days, which matches how
// long a squad's form actually stays relevant.
const RECENCY_LAMBDA = 0.97;

// Shrinkage strength when the squad's own history cannot yet estimate it —
// the spec's default, equivalent to assuming within-player variance is eight
// times between-player variance.
const DEFAULT_K = 8;

// k is a ratio of variances and the denominator can legitimately estimate to
// zero, which would shrink everyone onto the prior and make every player
// identical. That is the right *conclusion* when nobody is distinguishable, but
// an infinity is not a useful number to carry around, so it is capped and the
// degenerate case is reported instead of hidden.
const MAX_K = 40;

// Per-game score SD assumed before the squad has enough history to measure it.
// The spec's figure, and close to what the model actually produces.
const FALLBACK_SIGMA_WITHIN = 15;

// Effective games before a player can be benched by data at all.
const MIN_EFFECTIVE_GAMES = 4;

// Games of a player's own history before their own average becomes their prior,
// rather than the neutral 50.
const PRIOR_CAREER_GAMES = 30;

const Z95 = 1.96;

// How much two intervals may overlap before the two players are called
// indistinguishable. Measured against the narrower of the two.
const OVERLAP_TOLERANCE = 0.5;

const DAY_MS = 24 * 60 * 60 * 1000;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

/**
 * Whether a game is sound enough to bench someone on (spec §8.3).
 *
 * A partial game was scored without a timeline, so lane state, jungle pressure,
 * death context and objective control all dropped out of the rubric — the score
 * is real but it is not the same measurement. A LOW role confidence means the
 * player may have been compared to someone who was not their counterpart, and
 * that failure is silent: it produces a plausible-looking number rather than an
 * error.
 */
export function isBenchQuality(game, discordId) {
  const s = game.scores?.[discordId];
  if (!s || !Number.isFinite(s.composite)) return false;
  if ((s.dataQuality ?? game.dataQuality) !== 'full') return false;
  if (s.roleConfidence === 'LOW') return false;
  if (s.counterpartValid === false) return false;
  return true;
}

/**
 * Estimates how much of the spread between players is real.
 *
 * This is the "empirical" in empirical Bayes. Observed variance between player
 * means is inflated by sampling noise:
 *
 *     var(means) ~= sigma_between^2 + sigma_within^2 / n
 *
 * so the real between-player variance is what is left after subtracting the
 * noise. When that comes out at or below zero, the squad's players are not
 * distinguishable from each other given how many games they have played, and
 * the honest thing is to say so rather than to rank them anyway.
 */
export function estimateShrinkage(perPlayerScores) {
  const withEnough = perPlayerScores.filter((xs) => xs.length >= 2);
  if (withEnough.length < 2) {
    return { k: DEFAULT_K, sigmaWithin: FALLBACK_SIGMA_WITHIN, sigmaBetween: null, estimable: false };
  }

  // Pooled within-player variance.
  let ss = 0;
  let dof = 0;
  for (const xs of withEnough) {
    const m = mean(xs);
    for (const x of xs) ss += (x - m) ** 2;
    dof += xs.length - 1;
  }
  const varWithin = dof > 0 ? ss / dof : FALLBACK_SIGMA_WITHIN ** 2;

  const means = withEnough.map((xs) => mean(xs));
  const gm = mean(means);
  const varOfMeans = means.reduce((s, m) => s + (m - gm) ** 2, 0) / (means.length - 1);
  const nbar = mean(withEnough.map((xs) => xs.length));

  const varBetween = varOfMeans - varWithin / nbar;
  if (!(varBetween > 0)) {
    return {
      k: MAX_K,
      sigmaWithin: Math.sqrt(varWithin),
      sigmaBetween: 0,
      estimable: false
    };
  }

  return {
    k: Math.min(MAX_K, varWithin / varBetween),
    sigmaWithin: Math.sqrt(varWithin),
    sigmaBetween: Math.sqrt(varBetween),
    estimable: true
  };
}

/**
 * Recency weights and the effective sample size they amount to.
 *
 * The weights are anchored so the most recent game weighs 1, rather than being
 * taken raw against the clock. Both the weighted mean and the effective sample
 * size are invariant to a common factor across all the weights, so this changes
 * no result — but `0.97 ** 20000` underflows to exactly zero, and a set of
 * games that are all simply old would otherwise produce no weights, no mean and
 * an effective sample size of zero rather than the answer it actually has.
 */
export function recencyWeights(playedAts, now = Date.now(), lambda = RECENCY_LAMBDA) {
  if (playedAts.length === 0) return { weights: [], nEff: 0 };
  const lnL = Math.log(lambda);
  const exponents = playedAts.map((t) => Math.max(0, (now - t) / DAY_MS) * lnL);
  const anchor = Math.max(...exponents); // the newest game, i.e. the least negative
  const w = exponents.map((e) => Math.exp(e - anchor));
  const sum = w.reduce((a, b) => a + b, 0);
  const sumSq = w.reduce((a, b) => a + b * b, 0);
  // Kish's effective sample size: six games all weighted 1 count as six, six
  // where one carries most of the weight count as barely more than one.
  return { weights: w, nEff: sumSq > 0 ? (sum * sum) / sumSq : 0 };
}

/**
 * How much of the gap to the field each component accounts for, worst first.
 *
 * A bench call with no visible reason is the voice-chat blame problem with extra
 * latency. This turns "you scored 46" into "your deaths component is 9 below the
 * squad on a 20 weight, which is 1.8 of the gap" — a claim that can be argued
 * with, which is the point.
 */
function componentGap(mine, field) {
  const byKey = new Map(field.map((c) => [c.key, c]));
  return mine
    .filter((c) => c.reliable && byKey.has(c.key))
    .map((c) => {
      const theirs = byKey.get(c.key);
      return {
        key: c.key,
        label: c.label,
        mine: c.average,
        field: round1(theirs.average),
        delta: round1(c.average - theirs.average)
      };
    })
    .filter((c) => c.delta !== null && c.delta < 0)
    .sort((a, b) => a.delta - b.delta);
}

/**
 * Ratings for every registered player, lowest first.
 *
 * @param {object} opts
 * @param {number} opts.window - most recent games per player to consider
 * @param {number} opts.now - clock, injectable for tests
 * @returns {{ranked, provisional, shrinkage, excluded, staleCalibration, currentCalibration}}
 */
export function computeBenchRatings({
  window = 20,
  now = Date.now(),
  lambda = RECENCY_LAMBDA,
  minEffectiveGames = config.benchMinEffectiveGames ?? MIN_EFFECTIVE_GAMES
} = {}) {
  const players = db.allPlayers();
  const currentCalibration = db.getMeta?.('calibrationVersion') ?? null;

  let excluded = 0;
  let staleCalibration = 0;

  const raw = players.map((player) => {
    const all = db.gamesForPlayer(player.discordId, window);
    const usable = [];
    for (const g of all) {
      if (!isBenchQuality(g, player.discordId)) {
        excluded += 1;
        continue;
      }
      usable.push(g);
    }
    // Scores produced by different calibrations are not strictly comparable
    // (finding F9). They are counted rather than dropped, because dropping them
    // would empty the board on every recalibration and leave no bench call at
    // all; the count is surfaced so the fix — re-scoring — is obvious.
    const versions = new Set(usable.map((g) => g.scores[player.discordId].calibrationVersion ?? null));
    if (versions.size > 1) staleCalibration += 1;

    return {
      discordId: player.discordId,
      riotName: `${player.riotGameName}#${player.riotTagLine}`,
      displayName: player.riotGameName,
      games: usable,
      scores: usable.map((g) => g.scores[player.discordId].composite),
      playedAts: usable.map((g) => g.playedAt),
      mixedCalibration: versions.size > 1
    };
  });

  const shrinkage = estimateShrinkage(raw.map((r) => r.scores));

  // The prior a player is pulled toward: their own long-run average once there
  // is enough of it to mean anything, and the neutral 50 before that. Pulling
  // toward the squad average instead would make a consistently strong player
  // look worse the better their team-mates are, which is not what a bench call
  // is asking.
  const careerPrior = (discordId) => {
    const career = db.gamesForPlayer(discordId, Number.MAX_SAFE_INTEGER).filter((g) => isBenchQuality(g, discordId));
    if (career.length < PRIOR_CAREER_GAMES) return { prior: 50, from: 'neutral', games: career.length };
    return {
      prior: mean(career.map((g) => g.scores[discordId].composite)),
      from: 'career',
      games: career.length
    };
  };

  const rated = raw
    .filter((r) => r.scores.length > 0)
    .map((r) => {
      const { weights, nEff } = recencyWeights(r.playedAts, now, lambda);
      const wsum = weights.reduce((a, b) => a + b, 0);
      const weightedMean = wsum > 0 ? r.scores.reduce((s, x, i) => s + x * weights[i], 0) / wsum : null;

      const { prior, from, games: careerGames } = careerPrior(r.discordId);
      const rating = (nEff * weightedMean + shrinkage.k * prior) / (nEff + shrinkage.k);
      // The interval is on the shrunk rating, and shrinkage is itself a
      // variance reduction, so this is the conservative reading rather than the
      // flattering one.
      const halfWidth = nEff > 0 ? Z95 * (shrinkage.sigmaWithin / Math.sqrt(nEff)) : Infinity;

      return {
        discordId: r.discordId,
        riotName: r.riotName,
        displayName: r.displayName,
        gamesPlayed: r.scores.length,
        nEff: Math.round(nEff * 10) / 10,
        rawMean: round1(mean(r.scores)),
        weightedMean: round1(weightedMean),
        rating: round1(rating),
        low: round1(rating - halfWidth),
        high: round1(rating + halfWidth),
        interval: round1(halfWidth),
        prior: round1(prior),
        priorFrom: from,
        careerGames,
        mixedCalibration: r.mixedCalibration,
        recentScores: r.scores,
        byComponent: aggregateComponents(r.games, r.discordId),
        eligible: nEff >= minEffectiveGames
      };
    });

  // What the rest of the squad looks like, for the "why" on a bench call.
  const fieldComponents = (() => {
    const acc = new Map();
    for (const p of rated) {
      for (const c of p.byComponent) {
        if (!acc.has(c.key)) acc.set(c.key, []);
        acc.get(c.key).push(c.average);
      }
    }
    return [...acc.entries()].map(([key, xs]) => ({ key, average: mean(xs) }));
  })();

  for (const p of rated) p.gap = componentGap(p.byComponent, fieldComponents);

  return {
    ranked: rated.filter((p) => p.eligible).sort((a, b) => a.rating - b.rating),
    provisional: rated.filter((p) => !p.eligible).sort((a, b) => b.nEff - a.nEff),
    shrinkage,
    excluded,
    staleCalibration,
    currentCalibration,
    minEffectiveGames
  };
}

/**
 * How much two confidence intervals overlap, as a fraction of the narrower one.
 * 0 = disjoint, 1 = one contains the other.
 */
export function intervalOverlap(a, b) {
  const lo = Math.max(a.low, b.low);
  const hi = Math.min(a.high, b.high);
  const overlap = Math.max(0, hi - lo);
  const narrower = Math.min(a.high - a.low, b.high - b.low);
  return narrower > 0 ? Math.min(1, overlap / narrower) : overlap > 0 ? 1 : 0;
}

/**
 * The bench call itself.
 *
 * Returns `decisive: false` with the tied group when the bottom players cannot
 * be told apart. This is the part of the spec that matters most in practice:
 * the command's job is to be right, and "these two are the same within the
 * noise" is frequently the true answer for a six-person squad.
 */
export function benchVerdict(ranked, { tolerance = config.benchOverlapTolerance ?? OVERLAP_TOLERANCE } = {}) {
  if (ranked.length === 0) return { decisive: false, reason: 'nobody eligible', worst: null, tied: [] };
  if (ranked.length === 1) return { decisive: true, worst: ranked[0], tied: [], overlap: null };

  const worst = ranked[0];
  // Everyone the worst player cannot be distinguished from, not just the runner
  // up: three players inside the same band is three-way indistinguishable, and
  // naming one of them would be arbitrary.
  const tied = ranked.slice(1).filter((p) => intervalOverlap(worst, p) > tolerance);

  return {
    decisive: tied.length === 0,
    worst,
    tied,
    overlap: Math.round(intervalOverlap(worst, ranked[1]) * 100),
    tolerance
  };
}
