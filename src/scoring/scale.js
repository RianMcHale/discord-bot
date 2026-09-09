// Score curves.
//
// Every metric in every role rubric lands on the same 0-100 scale with one shared
// meaning: **50 = you did the job your role is supposed to do.** Either you went
// even with the player whose job was identical to yours (your lane counterpart),
// or you hit the baseline for your position.
//
// That shared anchor is the whole point. The old system min-max normalised each
// metric across the lobby, which meant a score only told you "where you ranked in
// this specific game" — a jungler could top the vision metric by out-warding four
// laners while losing every objective, and a support always won it by existing.
// Anchoring on 50 instead makes a jungler's 62 and an ADC's 62 mean the same
// thing: both beat their opposite number by a similar margin.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);

export const safeDiv = (a, b, fallback = 0) => (b > 0 ? a / b : fallback);

/**
 * Head-to-head share of a paired total, mapped so that even = 50.
 *
 * `prior` is a smoothing constant for low-count metrics: without it, 1 turret
 * plate vs 0 reads as a total blowout. With prior=2.5 it reads as a modest edge,
 * which is what one plate actually is.
 *
 * `gain` widens the spread so realistic advantages don't all cluster at 55-60
 * (a 2:1 edge with gain 1.35 lands at ~72 instead of ~67).
 */
export function versus(mine, theirs, { gain = 1.35, prior = 0 } = {}) {
  const a = Math.max(Number(mine) || 0, 0);
  const b = Math.max(Number(theirs) || 0, 0);
  const denom = a + b + prior;
  if (denom <= 0) return 50; // neither side generated any of it — nobody's fault
  return clamp(50 + ((a - b) / denom) * 50 * gain, 0, 100);
}

/** Same curve, but against a fixed role baseline instead of a live opponent. */
export function versusBaseline(mine, expected, opts) {
  if (!Number.isFinite(expected) || expected <= 0) return null;
  return versus(mine, expected, opts);
}

/**
 * A share measured against the share expected of the role, on a ratio.
 *
 * `versus` is the wrong shape for this. It divides by the sum of both values,
 * which is right when both are real players competing for one pool, and wrong
 * against a fixed bar: with a baseline of 26% damage share, a player doing 35%
 * — a dominant carry game — scored 58.8, and one doing *half their team's
 * entire damage* scored 69. Meanwhile a laner 2000g up at 14 scored 92, because
 * gold goes through `fromDiff`, whose scale is calibrated to what a real lead
 * looks like. Roles weighted toward share metrics were capped a full grade below
 * roles weighted toward difference metrics, for no reason anyone chose.
 *
 * Working in ratios fixes it: `full` is how far above par counts as completely
 * winning that axis, so 0.75 means "75% above the bar is a perfect score". Par
 * still lands exactly on 50, so nothing about an even game moves.
 */
export function versusShare(mine, expected, { full = 0.75 } = {}) {
  if (!Number.isFinite(mine) || !Number.isFinite(expected) || expected <= 0) return null;
  return fromDiff(mine / expected - 1, full);
}

/**
 * Maps a signed difference (gold, xp, cs) onto 0-100.
 * `full` is the difference that counts as completely winning the matchup.
 * `pivot` shifts what "even" means — this is where jungle pressure gets applied:
 * a top laner camped three times is measured against an expected deficit, not
 * against zero.
 * tanh is used instead of a linear ramp so a 6k lead doesn't score meaningfully
 * differently from a 4k lead (both are "you won the lane, completely").
 */
export function fromDiff(diff, full, { pivot = 0 } = {}) {
  if (!Number.isFinite(diff) || !(full > 0)) return null;
  return clamp(50 + 50 * Math.tanh(((diff - pivot) / full) * 1.1), 0, 100);
}

/**
 * Weighted mean that self-renormalises around missing components.
 * If the timeline endpoint failed, the components that needed it return null and
 * simply drop out of the average instead of dragging the score toward zero.
 */
export function weightedMean(components) {
  const usable = components.filter((c) => c && Number.isFinite(c.score) && c.weight > 0);
  if (usable.length === 0) return 50;
  const totalWeight = usable.reduce((s, c) => s + c.weight, 0);
  return usable.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight;
}

/**
 * How much of a metric is "did you beat your counterpart" versus "did you play
 * well" — the β term in the audit spec's §5.4.3.
 *
 * The spec defaults to 0.70, which is mostly matchup. The squad chose the
 * opposite: the score should say whether you played well, with the matchup as
 * context rather than as the verdict. At 0.35 a blended metric is roughly
 * two-thirds absolute.
 *
 * Not zero, deliberately. Keeping some differential is what stops a laner who
 * drew a smurf, or whose counterpart went AFK, from being judged as though the
 * lane were neutral — which is the case the counterpart comparison exists for.
 */
export const DIFFERENTIAL_WEIGHT = 0.35;

/** Blend a head-to-head score with a baseline score. `headToHeadShare` is β. */
export function blend(vsCounterpart, vsBaseline, headToHeadShare = DIFFERENTIAL_WEIGHT) {
  const a = Number.isFinite(vsCounterpart) ? vsCounterpart : null;
  const b = Number.isFinite(vsBaseline) ? vsBaseline : null;
  if (a === null) return b;
  if (b === null) return a;
  return a * headToHeadShare + b * (1 - headToHeadShare);
}

export function component(key, label, weight, score, detail = null) {
  return { key, label, weight, score: Number.isFinite(score) ? clamp(score, 0, 100) : null, detail };
}

// C is centred on 50 — "did your job" is a passing grade, not a D.
export function grade(score) {
  if (score >= 80) return 'S';
  if (score >= 70) return 'A';
  if (score >= 60) return 'B';
  if (score >= 47) return 'C';
  if (score >= 36) return 'D';
  return 'F';
}
