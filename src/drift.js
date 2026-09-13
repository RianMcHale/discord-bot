// Noticing when the calibration has stopped fitting the game (spec §7.5).
//
// The role bars were measured on patches 16.13–16.17. Riot ships a patch every
// two weeks, and a patch that buffs marksmen makes every ADC score above 50
// against a bar that has not moved. Nothing would say so: the scores would look
// exactly as authoritative as before, and the bench would start drifting toward
// whichever roles the patch happened to nerf.
//
// Two checks, adapted to a six-person squad rather than copied from the spec.
//
// PATCHES. The spec wants games past a meta break marked `calibration_stale` and
// kept out of bench decisions until recalibration. It does not want every patch
// treated that way — most are balance tweaks that barely move a role bar, and
// recalibrating costs a thousand API calls, so a bench that stopped working
// every fortnight would be worse than a slightly stale one. So ordinary patches
// are reported, and only patches the squad declares in META_BREAKS stop a game
// from benching anyone.
//
// DRIFT. The spec flags any role whose median score leaves 50 ± 3. For this bot
// that alarm would fire for the wrong reason: the squad is a premade group
// playing above its matchmaking rating, so its games skew above 50 across every
// role without anything being miscalibrated. What a stale bar actually does is
// move *one role against the others*. So each role is compared with the centre
// of all five, which cancels anything that shifts them together — squad skill,
// win rate — and leaves exactly the thing that makes a bench unfair.
//
// And it says when it cannot tell. The standard error on a median of forty
// scores is about three points, so a three-point drift is invisible in a week of
// games. Reporting "fine" off that would be the same overclaim finding F6 was
// about.

import { config } from './config.js';
import { calibrationVersion, calibrationSample } from './scoring/calibration.js';

const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const DAY_MS = 24 * 60 * 60 * 1000;

// How far a role may sit from the others before it counts as drift. The spec's
// figure, applied to the relative comparison rather than to the raw median.
const DRIFT_POINTS = 3;
// Below this many scores in a role there is nothing worth estimating.
const MIN_SAMPLE = 20;

/** "16.17.123.4567" -> "16.17". Riot numbers patches by season, not year. */
export function patchOf(gameVersion) {
  const [major, minor] = String(gameVersion || '').split('.');
  return major && minor && /^\d+$/.test(major) && /^\d+$/.test(minor) ? `${major}.${minor}` : null;
}

/** Sortable rank of a patch, so 16.9 comes before 16.10. */
export function patchRank(patch) {
  const [major, minor] = String(patch || '').split('.').map(Number);
  return Number.isFinite(major) && Number.isFinite(minor) ? major * 100 + minor : -1;
}

/** The patches the calibration was measured on, or null when there is none. */
export function calibratedPatches(sample = calibrationSample()) {
  const patches = Object.keys(sample?.patches || {}).sort((a, b) => patchRank(a) - patchRank(b));
  if (!patches.length) return null;
  return { min: patches[0], max: patches[patches.length - 1], list: patches, generatedAt: sample.generatedAt ?? null };
}

/** Patches the squad has declared a meta break, oldest first. */
export function metaBreaks() {
  return (config.metaBreaks || []).map(String).sort((a, b) => patchRank(a) - patchRank(b));
}

/**
 * Whether a game was played across a declared meta break the calibration does
 * not cover — the only case the spec says must stop a game benching anyone.
 */
export function isCalibrationStale(patch, cal = calibratedPatches()) {
  if (!patch || !cal) return false;
  const played = patchRank(patch);
  const calibratedTo = patchRank(cal.max);
  return metaBreaks().some((b) => {
    const r = patchRank(b);
    return r > calibratedTo && r <= played;
  });
}

/** Where the games stand relative to the calibration. */
export function patchStatus(games, cal = calibratedPatches()) {
  const played = [...new Set(games.map((g) => g.patch).filter(Boolean))].sort((a, b) => patchRank(a) - patchRank(b));
  const newest = played[played.length - 1] ?? null;

  if (!cal) return { calibrated: null, newest, ahead: null, crossedBreak: null, gamesWithoutPatch: countMissing(games) };

  // How many distinct patches past the calibration the squad is now playing on.
  // Counted from what was actually played, not by subtracting minor versions —
  // a season rollover would otherwise read as a hundred patches.
  const ahead = newest ? played.filter((p) => patchRank(p) > patchRank(cal.max)).length : 0;
  const crossedBreak = metaBreaks().find((b) => patchRank(b) > patchRank(cal.max) && newest && patchRank(b) <= patchRank(newest)) ?? null;

  return {
    calibrated: cal,
    newest,
    ahead,
    crossedBreak,
    staleGames: games.filter((g) => isCalibrationStale(g.patch, cal)).length,
    gamesWithoutPatch: countMissing(games)
  };
}

function countMissing(games) {
  return games.filter((g) => !g.patch).length;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Per role, how far its scores sit from the other roles, and whether that is
 * distinguishable from noise.
 *
 * Built from the opposing team's scores. They are strangers matched to the
 * squad's rating, and every game supplies one of each role, so the five-way
 * comparison is balanced. Their scores are pulled down a little when the squad
 * wins more than it loses — but that pulls all five roles down together, which
 * is exactly what the relative comparison cancels.
 */
export function driftReport(games, { days = 30, now = Date.now() } = {}) {
  const since = now - days * DAY_MS;
  const window = games.filter((g) => g.playedAt >= since && Array.isArray(g.enemy));

  const byRole = Object.fromEntries(ROLES.map((r) => [r, []]));
  for (const g of window) {
    for (const e of g.enemy) {
      if (byRole[e.role] && Number.isFinite(e.composite)) byRole[e.role].push(e.composite);
    }
  }

  const stats = ROLES.map((role) => {
    const xs = byRole[role];
    const med = median(xs);
    const mad = med === null ? null : median(xs.map((x) => Math.abs(x - med)));
    const sigma = mad === null ? null : 1.4826 * mad;
    // Standard error of a median, about 25% wider than for a mean.
    const se = sigma === null || xs.length === 0 ? null : (1.2533 * sigma) / Math.sqrt(xs.length);
    return { role, n: xs.length, median: med, se };
  });

  const measurable = stats.filter((s) => s.n >= MIN_SAMPLE && s.median !== null);
  const centre = measurable.length >= 3 ? median(measurable.map((s) => s.median)) : null;

  const roles = stats.map((s) => {
    if (centre === null || s.n < MIN_SAMPLE || s.se === null) {
      return { ...s, drift: null, verdict: 'thin' };
    }
    const drift = s.median - centre;
    // The centre is itself an estimate; its share of the uncertainty is small
    // with five roles, and folding it in keeps the check from being eager.
    const seDiff = s.se * Math.sqrt(1 + 1 / measurable.length);
    // How far off this role could plausibly be — the far edge of its interval.
    // Reported instead of a tick, because "no clear drift" on sixty scores and
    // "confirmed in step" on six hundred are different claims, and a tick makes
    // them look the same.
    const bound = Math.abs(drift) + 2 * seDiff;
    // Drifted only when the whole 95% interval clears the tolerance — when we are
    // confident the *true* drift exceeds three points, not merely that the
    // observed one does. The looser rule ("observed over 3, and significantly
    // non-zero") flagged a role whose true shift was 1.5 because sampling noise
    // put the observation at 3.5, which is a false alarm with a real cost: it
    // tells the squad not to trust a bench call that is fine, and prompts a
    // thousand-call recalibration for nothing. Missing a mild drift is the
    // cheaper mistake, and a real one — eight points — still clears easily.
    const drifted = Math.abs(drift) - 2 * seDiff > DRIFT_POINTS;
    // "In step" is only claimed when the whole interval sits inside the
    // tolerance — when a drift big enough to matter has actually been ruled out,
    // not merely not been seen.
    const verdict = drifted ? 'drifted' : bound <= DRIFT_POINTS ? 'in-step' : 'unclear';
    return { ...s, drift, seDiff, bound, verdict };
  });

  return {
    days,
    games: window.length,
    centre,
    roles,
    drifted: roles.filter((r) => r.verdict === 'drifted'),
    // Games needed per role before a three-point drift is visible at all, given
    // how spread the scores actually are. Said, so "not enough yet" has a number.
    gamesNeeded: estimateNeeded(stats),
    calibrationVersion: calibrationVersion()
  };
}

/** Roughly how many scores per role it takes for the check to resolve 3 points. */
function estimateNeeded(stats) {
  const sigmas = stats.map((s) => (s.se && s.n ? (s.se * Math.sqrt(s.n)) / 1.2533 : null)).filter(Boolean);
  const sigma = sigmas.length ? median(sigmas) : 16;
  // seDiff <= 3 with seDiff = 1.2533·σ/√n · √1.2
  return Math.ceil(((1.2533 * sigma * Math.sqrt(1.2)) / DRIFT_POINTS) ** 2);
}
