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
import { scoreRole, PRESSURE_CAP_AGAINST, PRESSURE_CAP_FOR } from './roles.js';
import { round1, clamp, grade } from './scale.js';
import { calibrationVersion } from './calibration.js';

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

const MIN_SCORABLE_SECONDS = 8 * 60; // anything shorter is a remake

// Short, scannable flags — these get rendered as one line under a compact
// scoreboard, so they have to earn their width. Only real signals fire.
function buildNotes(P, ctx) {
  const notes = [];

  // Reported at the value that actually moved the score, not the raw count — a
  // note saying "×6.9" next to an effect capped at 2 is just misleading.
  const effectivePressure =
    P.netPressure == null ? null : clamp(P.netPressure, -PRESSURE_CAP_FOR, PRESSURE_CAP_AGAINST);
  if (effectivePressure !== null && effectivePressure >= 1.5) {
    notes.push(`camped ×${effectivePressure.toFixed(1)} (lane bar lowered)`);
  } else if (effectivePressure !== null && effectivePressure <= -1.5) {
    notes.push(`jungler committed ×${Math.abs(effectivePressure).toFixed(1)} here (lane bar raised)`);
  }

  if (P.role === 'JUNGLE') {
    if (P.teamEpicControl != null && P.teamEpicControl < 0.35) {
      notes.push(`team held ${Math.round(P.teamEpicControl * 100)}% of epics`);
    }
    if (P.alliesUnanswered != null && P.alliesUnanswered >= 2.5) {
      notes.push(`left lanes ×${P.alliesUnanswered.toFixed(1)} unanswered`);
    }
    // The weighted figure, not the flat one: it is what the grade was actually
    // built from, so it is what the note has to report.
    const lanes = P.weightedLaneGold14 ?? P.teamLaneGold14;
    if (lanes != null && lanes <= -1500) {
      notes.push(`lanes ${Math.abs(Math.round(lanes / 100)) / 10}k down @${P.benchMinute}`);
    }
    if (P.tradeCount >= 2 && P.tradeValueLost > P.tradeValueWon * 1.4) {
      notes.push(`lost the cross-map trades (${P.tradeValueWon.toFixed(1)} for ${P.tradeValueLost.toFixed(1)})`);
    }
  }

  // Worth surfacing: it's the difference between "lost lane" and "lost lane and
  // then carried", which the 14-minute snapshot alone cannot show.
  if (P.goldDiff14 != null && P.postLaneSwing != null && P.goldDiff14 < -300 && P.postLaneSwing > 800) {
    notes.push(`down ${Math.abs(Math.round(P.goldDiff14))}g @${P.benchMinute}, +${Math.round(P.postLaneSwing)}g after`);
  }

  const solo = P.deathTags?.solo || 0;
  if (solo >= 3) notes.push(`${solo} solo deaths`);
  if (P.deathTags?.deep >= 2) notes.push(`${P.deathTags.deep} deaths alone in enemy half`);
  if (P.epicSteals > 0) notes.push(`${P.epicSteals} objective steal${P.epicSteals > 1 ? 's' : ''}`);
  if (ctx.hasTimeline && !P.counterpartPuuid) notes.push('no opposing player in this role');

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
      // How the role was decided, and how sure of it (spec §5.2, finding F1).
      // Persisted rather than discarded: when a counterpart comparison is wrong
      // the failure is silent, so the only defence is being able to see which
      // branch produced the assignment.
      roleConfidence: P.roleConfidence,
      roleBranch: P.roleBranch,
      counterpartValid: P.counterpartValid,
      champion: P.champion,
      teamId: P.teamId,
      kda: P.kda,
      win: P.win,
      isTracked: trackedPuuids.includes(P.puuid),
      dataQuality: ctx.hasTimeline ? 'full' : 'partial',
      // Whether the game was a real ten-player game (spec §12.1). A player who
      // left distorts all ten scores, not just the one opposite them: their four
      // team-mates split a team total between four rather than five so every
      // share on that side inflates, and the other five get a free lane. Scored
      // and shown either way — people want to see the game — but it cannot
      // decide a bench, on the same reasoning as a game with no timeline.
      lobbyIntact: ctx.lobbyIntact,
      earlySurrender: ctx.earlySurrender,
      // Which baselines produced this number (spec F9). Null while the model is
      // running on hand-set values. Stored per game so a rolling average can
      // tell whether it is mixing scores that mean different things.
      calibrationVersion: calibrationVersion(),
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
        postLaneSwing: P.postLaneSwing == null ? null : Math.round(P.postLaneSwing),
        netJunglePressure: P.netPressure == null ? null : round1(P.netPressure),
        teamEpicControl: P.teamEpicControl == null ? null : round1(P.teamEpicControl * 100),
        epicShare: P.epicShare == null ? null : round1(P.epicShare * 100),
        tookSoul: P.tookSoul,
        concededSoul: P.concededSoul,
        drakesTaken: P.drakesTaken,
        teamLaneGold14: P.teamLaneGold14 == null ? null : Math.round(P.teamLaneGold14),
        weightedLaneGold14: P.weightedLaneGold14 == null ? null : Math.round(P.weightedLaneGold14),
        weightedLanePostSwing: P.weightedLanePostSwing == null ? null : Math.round(P.weightedLanePostSwing),
        lanePresence: P.lanePresence ?? null,
        tradeValueWon: P.tradeCount ? round1(P.tradeValueWon) : null,
        tradeValueLost: P.tradeCount ? round1(P.tradeValueLost) : null,
        alliesUnanswered: P.alliesUnanswered == null ? null : round1(P.alliesUnanswered),
        lanesLeftHanging: P.lanesLeftHanging == null ? null : round1(P.lanesLeftHanging),
        lanesAnswered: P.lanesAnswered == null ? null : round1(P.lanesAnswered),
        jungleControl: P.jungleControl,
        enemyJunglerTakedowns: P.enemyJunglerTakedowns,
        invadeDeaths: P.invadeDeaths,
        weightedDeaths: P.weightedDeathsPerMin == null ? null : round1(P.weightedDeathsPerMin * ctx.minutes),
        lateKp: P.lateKp == null ? null : Math.round(P.lateKp * 100),
        killShare: P.killShare == null ? null : Math.round(P.killShare * 100),

        // The raw figures behind each component, so /explain can say why a
        // component landed where it did in words ("6.5 CS a minute against the
        // 7.7 an ADC usually manages") rather than by parsing the detail line
        // back apart. Stored, not recomputed later, because the explanation has
        // to describe the game as it was scored.
        minutes: round1(ctx.minutes),
        deaths: P.deaths,
        deathTags: P.deathTags ? { ...P.deathTags } : null,
        csPerMin: round2(P.csPerMin),
        goldPerMin: Math.round(P.goldPerMin ?? 0),
        dmgShare: P.teamDamageShare == null ? null : Math.round(P.teamDamageShare * 100),
        damagePerGoldShare: P.damagePerGoldShare == null ? null : round2(P.damagePerGoldShare),
        kp: P.kp == null ? null : Math.round(P.kp * 100),
        visionPerMin: round2(P.visionPerMin),
        controlWards: P.controlWards ?? null,
        turretDamage: P.turretDamage ?? null,
        ccScore: P.ccScore ?? null,
        healShieldPerMin: P.healShieldPerMin == null ? null : Math.round(P.healShieldPerMin),
        gankTakedowns: P.gankTakedowns ?? null,
        roamTakedowns: P.roamTakedowns ?? null,
        soloKills: P.soloKills ?? null,
        platesEarly: P.platesEarly ?? null,
        platesLate: P.platesLate ?? null
      },
      notes: buildNotes(P, ctx)
    };
  }

  return result;
}

export { grade } from './scale.js';
export { BASELINE } from './roles.js';
