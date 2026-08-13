// Match scoring entry point.
//
// scoreMatch() grades every player in the lobby against the rubric for the role
// they actually played (roles.js), using context derived from the match and its
// timeline (context.js). The 0-100 output means the same thing for all five
// roles: 50 = you did your job, higher = you beat the player opposite you at it.
//
// The old model normalised four role-neutral metrics across the lobby, which
// made deaths-per-minute the dominant signal for everyone. That flattered any
// jungler who farmed safely and punished any laner who got camped. Neither is a
// judgement League itself would make.

import { buildContext } from './context.js';
import { scoreRole } from './roles.js';
import { round1, clamp, grade } from './scale.js';

// Reserved for the teammate impact vote (/vote). Stats can't see "threw the
// fight by overextending" or "made the call that won the game".
export const VOTE_WEIGHT = 0.15;
const OBJECTIVE_WEIGHT = 1 - VOTE_WEIGHT;

const MIN_SCORABLE_SECONDS = 8 * 60; // anything shorter is a remake

function buildNotes(P, ctx) {
  const notes = [];

  if (P.netPressure != null && P.netPressure >= 1.5) {
    notes.push(
      `Camped — net ${P.netPressure.toFixed(1)} enemy jungle commitments, lane graded against an expected deficit`
    );
  } else if (P.netPressure != null && P.netPressure <= -1.5) {
    notes.push(`Jungler invested ${Math.abs(P.netPressure).toFixed(1)} commitments here — lane bar raised to match`);
  }

  if (P.role === 'JUNGLE') {
    if (P.teamEpicControl != null && P.teamEpicControl < 0.35) {
      notes.push(`Team held only ${Math.round(P.teamEpicControl * 100)}% of epic objectives`);
    }
    if (P.alliesUnanswered != null && P.alliesUnanswered >= 2.5) {
      notes.push(`Lanes ate ${P.alliesUnanswered.toFixed(1)} unanswered jungle commitments`);
    }
    if (P.teamLaneGold14 != null && P.teamLaneGold14 <= -1500) {
      notes.push(`Lanes were ${Math.abs(Math.round(P.teamLaneGold14))}g down at ${P.benchMinute}`);
    }
  }

  const solo = P.deathTags?.solo || 0;
  if (solo >= 3) notes.push(`${solo} solo deaths`);
  if (P.deathTags?.deep >= 2) notes.push(`${P.deathTags.deep} deaths alone in enemy territory`);
  if (P.epicSteals > 0) notes.push(`${P.epicSteals} objective steal${P.epicSteals > 1 ? 's' : ''}`);

  if (!ctx.hasTimeline) {
    notes.push('Timeline unavailable — lane state, gank pressure and death context could not be measured');
  } else if (!P.counterpartPuuid) {
    notes.push('No opposing player in this role — graded against role baselines only');
  }

  return notes;
}

/**
 * Scores every player in the match.
 *
 * @param {object} match - raw match-v5 "get match" response
 * @param {object} opts
 * @param {object|null} opts.timeline - match-v5 timeline response, or null. Optional
 *   but strongly recommended: without it, lane state at 14, jungle pressure,
 *   death context and objective control all drop out of the rubrics.
 * @param {string[]} opts.trackedPuuids - puuids in your rotation, used only to
 *   set `isTracked`. Scoring itself no longer needs teammates present, because
 *   each player is measured against their lane counterpart rather than the squad.
 * @returns {Record<string, object>} keyed by puuid
 */
export function scoreMatch(match, { timeline = null, trackedPuuids = [] } = {}) {
  const ctx = buildContext(match, timeline);

  if (ctx.durationSeconds < MIN_SCORABLE_SECONDS) {
    throw new Error(`Match is only ${Math.round(ctx.durationSeconds / 60)} minutes long — too short to score.`);
  }

  const result = {};
  for (const P of ctx.players) {
    const { composite, components } = scoreRole(P, ctx);
    const breakdown = {};
    for (const c of components) breakdown[c.key] = c.score === null ? null : round1(c.score);

    result[P.puuid] = {
      composite: round1(clamp(composite, 0, 100)),
      grade: grade(composite),
      role: P.role,
      champion: P.champion,
      teamId: P.teamId,
      kda: P.kda,
      win: P.win,
      isTracked: trackedPuuids.includes(P.puuid),
      dataQuality: ctx.hasTimeline ? 'full' : 'partial',
      components: components.map((c) => ({
        key: c.key,
        label: c.label,
        weight: c.weight,
        score: c.score === null ? null : round1(c.score),
        detail: c.detail
      })),
      breakdown,
      context: {
        benchMinute: P.benchMinute,
        goldDiff14: P.goldDiff14 == null ? null : Math.round(P.goldDiff14),
        xpDiff14: P.xpDiff14 == null ? null : Math.round(P.xpDiff14),
        csDiff14: P.csDiff14,
        netJunglePressure: P.netPressure == null ? null : round1(P.netPressure),
        teamEpicControl: P.teamEpicControl == null ? null : round1(P.teamEpicControl * 100),
        epicShare: P.epicShare == null ? null : round1(P.epicShare * 100),
        teamLaneGold14: P.teamLaneGold14 == null ? null : Math.round(P.teamLaneGold14),
        weightedDeaths: P.weightedDeathsPerMin == null ? null : round1(P.weightedDeathsPerMin * ctx.minutes),
        lateKp: P.lateKp == null ? null : Math.round(P.lateKp * 100)
      },
      notes: buildNotes(P, ctx)
    };
  }

  return result;
}

/**
 * Combines a player's objective composite with an average teammate vote (1-5).
 * Unchanged from the previous model — the vote still fills the last 15%.
 */
export function finalScoreWithVotes(objectiveComposite, avgVote /* 1-5 or null */) {
  if (avgVote === null || avgVote === undefined) return objectiveComposite;
  const voteAsScore = ((avgVote - 1) / 4) * 100;
  return round1(objectiveComposite * OBJECTIVE_WEIGHT + voteAsScore * VOTE_WEIGHT);
}

export { grade } from './scale.js';
export { BASELINE } from './roles.js';
