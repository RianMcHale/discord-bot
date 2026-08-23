// The five role rubrics.
//
// Each role is graded on what League actually asks that role to do, against the
// player on the other team whose job was identical. That's the fix for the two
// failure modes of a single lobby-wide composite:
//
//   * A jungler who farmed 20 camps, never contested an objective and finished
//     3/2/9 used to score well — low deaths, decent KP, and vision score that
//     beat three laners. Here, half their grade is objective control and the
//     state of their lanes at 14 minutes, so "I had no impact" reads as a bad
//     game, which is what it was.
//
//   * A top laner camped three times used to eat the full deaths penalty at 35%
//     weight. Here, their lane is graded against an *expected* deficit that
//     scales with the jungle pressure they took, ganked deaths are discounted,
//     and the pressure they ate shows up on the enemy jungler's grade as credit
//     and on their own jungler's grade as a debt.
//
// Weights per role sum to 100. Components that need timeline data return null
// and drop out of the average rather than scoring zero.

import { versus, fromDiff, weightedMean, blend, component, clamp, safeDiv } from './scale.js';

// Rough Summoner's Rift role averages. Used as the second anchor so a lane where
// both players were awful doesn't hand one of them a good score just for being
// marginally less awful.
export const BASELINE = {
  TOP: { dmgShare: 0.21, tankShare: 0.27, kp: 0.5, csPerMin: 6.4, visionPerMin: 0.55, wDeathsPerMin: 0.2, epicShare: 0.45 },
  JUNGLE: { dmgShare: 0.18, tankShare: 0.21, kp: 0.62, csPerMin: 5.6, visionPerMin: 0.9, wDeathsPerMin: 0.19, epicShare: 0.75 },
  MIDDLE: { dmgShare: 0.26, tankShare: 0.17, kp: 0.58, csPerMin: 7.0, visionPerMin: 0.65, wDeathsPerMin: 0.18, epicShare: 0.5 },
  BOTTOM: { dmgShare: 0.28, tankShare: 0.15, kp: 0.56, csPerMin: 7.6, visionPerMin: 0.55, wDeathsPerMin: 0.17, epicShare: 0.55 },
  UTILITY: { dmgShare: 0.09, tankShare: 0.2, kp: 0.62, csPerMin: 1.2, visionPerMin: 1.9, wDeathsPerMin: 0.22, epicShare: 0.4 },
  UNKNOWN: { dmgShare: 0.2, tankShare: 0.2, kp: 0.57, csPerMin: 5.5, visionPerMin: 0.9, wDeathsPerMin: 0.19, epicShare: 0.5 }
};

// Gold swing a single committed jungle play is worth, including the tempo the
// laner loses backing off the wave. Capped at 3 net commitments so a genuinely
// 5k-down lane can't be fully excused by "I got camped".
const PRESSURE_GOLD = 380;
const PRESSURE_XP = 240;
// Asymmetric on purpose. Lowering the bar for a camped laner is backed by kill
// events; raising it for a laner whose jungler "helped" is inferred from weaker
// evidence, so it can move the bar less far. Wrongly excusing a bad lane is a
// mild error; wrongly punishing a laner for their jungler's pathing is not.
export const PRESSURE_CAP_AGAINST = 3;
export const PRESSURE_CAP_FOR = 2;

// A lane snapshot describes a smaller share of a longer game. Laning is most of
// a 22-minute game and a prelude to a 40-minute one, so its weight scales with
// how long the game actually ran. Late-scaling champions were being graded as if
// minute 14 decided the match.
const LANE_REFERENCE_MINUTES = 27;

// How far a post-laning recovery can lift a lost lane, and how far throwing a
// lead can drag one down. Recovery is worth more than the throw is punished:
// coming back from a deficit takes play, losing a lead often takes a teamfight.
const COMEBACK_MAX = 28;
const THROWN_LEAD_MAX = 10;

/** Scales a lane component's weight by game length. */
export function laneWeight(base, ctx) {
  return Math.round(base * clamp(LANE_REFERENCE_MINUTES / ctx.minutes, 0.5, 1.2));
}

/**
 * Credit for erasing a deficit after laning, or the cost of giving a lead away.
 *
 * A snapshot at 14 minutes cannot tell "went even and stayed there" apart from
 * "was a thousand down and out-earned them for the next twenty minutes". Every
 * role gets this: a jungler whose lanes were behind at 14 and level by the end
 * did the same job a scaling carry did, just measured on the whole map.
 *
 * `floor` is the smallest deficit worth scaling against, so a 200g gap doesn't
 * turn a modest recovery into a full 28 points. It scales with the metric —
 * individual gold uses a few hundred, whole-team gold a few thousand.
 */
function comebackAdjustment(diff, swing, { floor = 800 } = {}) {
  if (!Number.isFinite(diff) || !Number.isFinite(swing)) return 0;
  if (diff < -floor * 0.375 && swing > 0) {
    return clamp(swing / Math.max(-diff, floor), 0, 1) * COMEBACK_MAX;
  }
  if (diff > floor * 0.375 && swing < 0) {
    return -clamp(-swing / Math.max(diff, floor), 0, 1) * THROWN_LEAD_MAX;
  }
  return 0;
}

/** Renders the post-lane swing for a component detail line. */
function comebackDetail(comeback, swing) {
  if (Math.abs(comeback) < 1) return '';
  return ` · ${comeback > 0 ? '+' : ''}${Math.round(comeback)} post-lane (${swing >= 0 ? '+' : ''}${Math.round(swing)}g)`;
}

const opponentOf = (P, ctx) => (P.counterpartPuuid ? ctx.byPuuid.get(P.counterpartPuuid) : null) || null;

const scaleToBench = (value, P) => value * clamp((P.benchMinute ?? 14) / 14, 0.4, 1);

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

/**
 * Lane result at the end of laning, measured against the deficit the player was
 * *expected* to be at given the jungle pressure both ways. Net +2 pressure moves
 * "even" to roughly -760 gold: staying only 400 down through two ganks is a good
 * lane, and the score says so.
 */
function laneComponent(P, ctx, { goldFull = 1800, xpFull = 1400, source = 'individual' } = {}) {
  const net = clamp(P.netPressure ?? 0, -PRESSURE_CAP_FOR, PRESSURE_CAP_AGAINST);
  const goldPivot = -net * PRESSURE_GOLD;
  const xpPivot = -net * PRESSURE_XP;

  const individual = P.goldDiff14;
  const pair = P.pairGoldDiff14;
  let goldDiff = individual;
  let full = goldFull;
  if (source === 'pair') {
    goldDiff = pair;
    full = goldFull * 1.45;
  } else if (source === 'both' && Number.isFinite(individual) && Number.isFinite(pair)) {
    goldDiff = individual * 0.6 + (pair / 2) * 0.4;
  }

  const goldScore = fromDiff(goldDiff, scaleToBench(full, P), { pivot: scaleToBench(goldPivot, P) });
  const xpScore = fromDiff(P.xpDiff14, scaleToBench(xpFull, P), { pivot: scaleToBench(xpPivot, P) });

  const laned = weightedMean([
    { score: goldScore, weight: 0.6 },
    { score: xpScore, weight: 0.4 }
  ]);
  if (goldScore === null && xpScore === null) return null;

  // What happened after laning, measured the same way the deficit was. A bot
  // lane graded on the pair's economy has to have its recovery measured on the
  // pair too, or the support is credited for their ADC's comeback and vice versa.
  const swing = source === 'pair' ? P.pairPostLaneSwing : P.postLaneSwing;
  const comeback = comebackAdjustment(goldDiff, swing, { floor: source === 'pair' ? 1200 : 800 });

  const score = clamp(laned + comeback, 0, 100);

  const detail =
    Number.isFinite(goldDiff) &&
    `${goldDiff >= 0 ? '+' : ''}${Math.round(goldDiff)}g @${P.benchMinute ?? 14}` +
      (net !== 0 ? ` (bar ${goldPivot >= 0 ? '+' : ''}${Math.round(goldPivot)}g)` : '') +
      comebackDetail(comeback, swing);

  return { score, detail: detail || null, comeback };
}

/**
 * Deaths, weighted by how much of each one was actually the player's fault (see
 * `weighDeath` in context.js), then compared to the counterpart who played the
 * same role in the same game — and to the role baseline so a lane where both
 * players inted doesn't produce a winner.
 */
function deathComponent(P, ctx, baseline) {
  const opp = opponentOf(P, ctx);
  const mine = P.weightedDeathsPerMin ?? safeDiv(P.deaths, ctx.minutes);
  const theirs = opp ? opp.weightedDeathsPerMin ?? safeDiv(opp.deaths, ctx.minutes) : null;
  // Operands are reversed: fewer deaths is better.
  const vsOpp = theirs === null ? null : versus(theirs, mine, { prior: 0.12, gain: 1.3 });
  const vsBase = versus(baseline.wDeathsPerMin, mine, { prior: 0.12, gain: 1.3 });
  const tags = P.deathTags || {};
  const detail =
    `${P.deaths} death${P.deaths === 1 ? '' : 's'}` +
    (tags.solo ? ` · ${tags.solo} solo` : '') +
    (tags.ganked ? ` · ${tags.ganked} ganked` : '') +
    (tags.teamfight ? ` · ${tags.teamfight} in fights` : '');
  return { score: blend(vsOpp, vsBase, 0.55), detail };
}

/**
 * Teamfight contribution. Damage share and damage-taken share are both valid —
 * a Sion top and a Camille top do the job differently. For roles where both are
 * legitimate (`specialist`), being excellent at one is enough; for an ADC it
 * isn't, so the weighted blend stands.
 */
function combatComponent(P, ctx, baseline, { frontlineShare = 0.2, specialist = false, useDpm = true } = {}) {
  const opp = opponentOf(P, ctx);
  const dmgScore = P.teamDamageShare == null ? null : versus(P.teamDamageShare, baseline.dmgShare, { prior: 0.03, gain: 1.25 });
  const tankScore = P.teamTakenShare == null ? null : versus(P.teamTakenShare, baseline.tankShare, { prior: 0.05, gain: 1.0 });

  let shareScore = weightedMean([
    { score: dmgScore, weight: 1 - frontlineShare },
    { score: tankScore, weight: frontlineShare }
  ]);
  if (dmgScore === null && tankScore === null) shareScore = null;
  else if (specialist) {
    // 0.9 so a specialist still can't quite match someone strong at both.
    shareScore = Math.max(shareScore, Math.max(dmgScore ?? 0, tankScore ?? 0) * 0.9);
  }

  const dpmScore = useDpm && opp ? versus(P.dpm, opp.dpm, { prior: 60, gain: 1.25 }) : null;

  const score = weightedMean([
    { score: shareScore, weight: 0.62 },
    { score: dpmScore, weight: 0.38 }
  ]);
  const detail = P.teamDamageShare == null ? null : `${Math.round(P.teamDamageShare * 100)}% team dmg`;
  return { score, detail };
}

/**
 * Objective involvement: your share of what your team took, whether your team
 * took anything at all, and structure damage.
 *
 * `controlShare` is how much of the grade is the *team's* objective control.
 * It's high for junglers (that is their job) and low for everyone else, who can
 * only show up for what gets started.
 */
function objectiveComponent(P, ctx, baseline, { controlShare = 0.3 } = {}) {
  const opp = opponentOf(P, ctx);

  // Against the counterpart first: "did you show up for objectives more than the
  // player in your role on the other team" survives a game where nobody took any.
  const vsOpp = opp ? versus(P.personalEpics, opp.personalEpics, { prior: 1.2, gain: 1.3 }) : null;
  let shareScore = P.epicShare == null ? null : versus(P.epicShare, baseline.epicShare, { prior: 0.15, gain: 1.2 });
  // With only one or two epics on the board, "you weren't on it" is noise, not a
  // verdict. Shrink toward neutral until there's enough on the board to judge.
  if (shareScore !== null && P.teamEpicWeighted != null) {
    const confidence = clamp(P.teamEpicWeighted / 4, 0, 1);
    shareScore = 50 + (shareScore - 50) * confidence;
  }
  const involvement = blend(vsOpp, shareScore, 0.55);

  const controlScore = P.teamEpicControl == null ? null : clamp(50 + (P.teamEpicControl - 0.5) * 100 * 1.2, 0, 100);
  const turretScore = opp ? versus(P.turretDamage, opp.turretDamage, { prior: 1500, gain: 1.3 }) : null;

  let score = weightedMean([
    { score: involvement, weight: 1 - controlShare - 0.15 },
    { score: controlScore, weight: controlShare },
    { score: turretScore, weight: 0.15 }
  ]);
  if (P.epicSteals > 0) score = clamp(score + Math.min(P.epicSteals, 2) * 3, 0, 100);

  const detail =
    P.teamEpicControl == null
      ? `${P.personalEpics.toFixed(1)} objective takedowns`
      : `${Math.round((P.epicShare ?? 0) * 100)}% of team's · team held ${Math.round(P.teamEpicControl * 100)}%`;
  return { score, detail };
}

/**
 * Nudges a score by the net jungle pressure a lane took, ±4 points per net
 * commitment up to ±12.
 *
 * The lane component already grades against an expected gold deficit, but that
 * isn't the only thing camping costs you: a top laner who is dived every wave
 * can't take plates, can't push for turret damage, and can't leave to help
 * elsewhere. Grading those raw against an enemy laner who had a jungler holding
 * their hand punishes the same player twice for the same event.
 */
function pressureAdjusted(score, P, perCommit = 4) {
  if (score === null || P.netPressure == null) return score;
  return clamp(score + clamp(P.netPressure, -PRESSURE_CAP_FOR, PRESSURE_CAP_AGAINST) * perCommit, 0, 100);
}

function visionComponent(P, ctx, baseline) {
  const opp = opponentOf(P, ctx);
  const vsOpp = opp ? versus(P.visionPerMin, opp.visionPerMin, { prior: 0.2 }) : null;
  const vsBase = versus(P.visionPerMin, baseline.visionPerMin, { prior: 0.2 });
  const cwScore = opp ? versus(P.controlWards, opp.controlWards, { prior: 2.5, gain: 1.3 }) : null;
  const clearScore = opp ? versus(P.wardTakedownsPerMin, opp.wardTakedownsPerMin, { prior: 0.12, gain: 1.3 }) : null;

  const score = weightedMean([
    { score: blend(vsOpp, vsBase, 0.6), weight: 0.5 },
    { score: cwScore, weight: 0.25 },
    { score: clearScore, weight: 0.25 }
  ]);
  return { score, detail: `${P.visionPerMin.toFixed(2)} vis/min · ${P.controlWards} pinks` };
}

// Average kill participation across a team in a typical game — roughly 1.8
// assists per kill, so takedowns come to ~2.8x the kill count spread over five
// players. The role baselines are calibrated against this.
const TYPICAL_TEAM_AVG_KP = 0.55;

/**
 * Kill participation, weighted toward the fights after laning ends.
 *
 * The baseline is rescaled by how this specific game distributed its kills.
 * Kill participation is a share of your own team's kills, so a 38-kill game of
 * solo picks compresses everyone's number — the highest on the team can sit
 * below a role baseline that assumes a normal game. Grading against the fixed
 * figure marked a support who was second-most-involved on their team as absent.
 */
function participationComponent(P, ctx, baseline) {
  const spread = P.teamAvgKp ? clamp(P.teamAvgKp / TYPICAL_TEAM_AVG_KP, 0.6, 1.4) : 1;
  const expected = baseline.kp * spread;

  const overall = versus(P.kp, expected, { prior: 0.1, gain: 1.2 });
  const late = P.lateKp == null ? null : versus(P.lateKp, expected, { prior: 0.1, gain: 1.2 });
  const score = weightedMean([
    { score: overall, weight: 0.5 },
    { score: late, weight: 0.5 }
  ]);
  const detail =
    `${Math.round(P.kp * 100)}% KP` +
    (P.lateKp == null ? '' : ` · ${Math.round(P.lateKp * 100)}% post-15`) +
    (Math.abs(spread - 1) > 0.08 ? ` · bar ${Math.round(expected * 100)}%` : '');
  return { score, detail };
}

// ---------------------------------------------------------------------------
// Role rubrics
// ---------------------------------------------------------------------------

// TOP — an isolated lane that gets weak-sided. Judged on holding the matchup
// under whatever pressure came, converting a lead into plates and turret damage,
// and actually being present for fights instead of split-pushing into nothing.
function scoreTop(P, ctx) {
  const b = BASELINE.TOP;
  const opp = opponentOf(P, ctx);
  const lane = laneComponent(P, ctx);
  const side = {
    score: pressureAdjusted(
      weightedMean([
        { score: opp ? versus(P.platesTaken, opp.platesTaken, { prior: 2.5, gain: 1.4 }) : null, weight: 0.45 },
        { score: opp ? versus(P.turretDamage, opp.turretDamage, { prior: 2000, gain: 1.3 }) : null, weight: 0.35 },
        { score: opp ? versus(P.soloKills, opp.soloKills, { prior: 1.2, gain: 1.4 }) : null, weight: 0.2 }
      ]),
      P
    ),
    detail: `${P.platesTaken} plates · ${Math.round(P.turretDamage / 100) / 10}k turret dmg`
  };

  return {
    components: [
      component('lane', 'Lane', laneWeight(25, ctx), lane?.score, lane?.detail),
      component('sidelane', 'Side lane', 15, side.score, side.detail),
      component('combat', 'Teamfight', 22, ...pick(combatComponent(P, ctx, b, { frontlineShare: 0.4, specialist: true }))),
      component('deaths', 'Deaths', 20, ...pick(deathComponent(P, ctx, b))),
      component('objectives', 'Objectives', 10, ...pick(objectiveComponent(P, ctx, b, { controlShare: 0.25 }))),
      component('presence', 'Presence', 8, ...pick(participationComponent(P, ctx, b)))
    ]
  };
}

// JUNGLE — the macro role, and the one the old scoring let off easiest. Half the
// grade is objective control plus the state of the three lanes at 14 minutes:
// the two things a jungler is uniquely responsible for. Deaths are the *lightest*
// weight of any role on purpose — dying contesting a baron is the job, and low
// deaths must not be a route to a good score for a jungler who did nothing.
function scoreJungle(P, ctx) {
  const b = BASELINE.JUNGLE;
  const opp = opponentOf(P, ctx);

  // The jungler's version of a comeback. Their lanes being 3k down at 14 and
  // level by the end is the same achievement a scaling carry gets credit for —
  // it just shows up across the whole map instead of one lane. Team-scale gold,
  // so the floor is a few thousand rather than a few hundred.
  const mapComeback = comebackAdjustment(P.teamLaneGold14, P.teamPostLaneSwing, { floor: 2600 });
  const mapState = {
    score: (() => {
      const base = fromDiff(P.teamLaneGold14, scaleToBench(3200, P));
      return base === null ? null : clamp(base + mapComeback, 0, 100);
    })(),
    detail:
      P.teamLaneGold14 == null
        ? null
        : `lanes ${P.teamLaneGold14 >= 0 ? '+' : ''}${Math.round(P.teamLaneGold14)}g @${P.benchMinute ?? 14}` +
          comebackDetail(mapComeback, P.teamPostLaneSwing)
  };

  // Gank conversion: takedowns your commitments produced, versus the enemy
  // jungler's. Counter-response: how much unanswered pressure your own lanes ate
  // while you were elsewhere.
  const myPlays = P.gankTakedowns + Math.min(P.laneVisitsGiven, 6) * 0.3;
  const theirPlays = opp ? opp.gankTakedowns + Math.min(opp.laneVisitsGiven, 6) * 0.3 : null;
  const conversion = theirPlays === null ? null : versus(myPlays, theirPlays, { prior: 1.5, gain: 1.35 });
  const response =
    opp && P.alliesUnanswered != null && opp.alliesUnanswered != null
      ? versus(opp.alliesUnanswered, P.alliesUnanswered, { prior: 1.5, gain: 1.3 })
      : null;
  const pressure = {
    score: weightedMean([
      { score: conversion, weight: 0.55 },
      { score: response, weight: 0.45 }
    ]),
    detail: `${P.gankTakedowns} gank takedowns` + (P.alliesUnanswered != null ? ` · ${P.alliesUnanswered.toFixed(1)} unanswered` : '')
  };

  const economy = {
    score: weightedMean([
      { score: opp ? versus(P.jungleCs14, opp.jungleCs14, { prior: 8, gain: 1.4 }) : null, weight: 0.4 },
      { score: opp ? versus(P.csPerMin, opp.csPerMin, { prior: 1.5, gain: 1.4 }) : null, weight: 0.35 },
      { score: opp ? versus(P.counterJungleCs, opp.counterJungleCs, { prior: 4, gain: 1.3 }) : null, weight: 0.25 }
    ]),
    detail: `${P.csPerMin.toFixed(1)} cs/min · ${P.counterJungleCs} enemy camps`
  };

  return {
    components: [
      component('objectives', 'Objectives', 24, ...pick(objectiveComponent(P, ctx, b, { controlShare: 0.5 }))),
      component('mapstate', 'Lanes @14', 20, mapState.score, mapState.detail),
      component('pressure', 'Gank impact', 14, pressure.score, pressure.detail),
      component('economy', 'Jungle farm', 12, economy.score, economy.detail),
      component('vision', 'Vision', 10, ...pick(visionComponent(P, ctx, b))),
      component('combat', 'Teamfight', 12, ...pick(combatComponent(P, ctx, b, { frontlineShare: 0.35, specialist: true }))),
      component('deaths', 'Deaths', 8, ...pick(deathComponent(P, ctx, b)))
    ]
  };
}

// MID — the highest-agency lane. Winning the matchup is only half of it; the
// other half is whether that prio turned into pressure elsewhere on the map.
function scoreMid(P, ctx) {
  const b = BASELINE.MIDDLE;
  const opp = opponentOf(P, ctx);
  const lane = laneComponent(P, ctx);

  const roam = {
    score: weightedMean([
      { score: participationComponent(P, ctx, b).score, weight: 0.6 },
      { score: opp ? versus(P.personalEpics, opp.personalEpics, { prior: 1.2, gain: 1.3 }) : null, weight: 0.4 }
    ]),
    detail: `${Math.round(P.kp * 100)}% KP` + (P.lateKp == null ? '' : ` · ${Math.round(P.lateKp * 100)}% post-15`)
  };

  const tempo = {
    score: weightedMean([
      { score: pressureAdjusted(opp ? versus(P.csPerMin, opp.csPerMin, { prior: 1.5, gain: 1.4 }) : null, P, 3), weight: 0.6 },
      { score: visionComponent(P, ctx, b).score, weight: 0.4 }
    ]),
    detail: `${P.csPerMin.toFixed(1)} cs/min · ${P.visionPerMin.toFixed(2)} vis/min`
  };

  return {
    components: [
      component('lane', 'Lane', laneWeight(24, ctx), lane?.score, lane?.detail),
      component('combat', 'Damage', 24, ...pick(combatComponent(P, ctx, b, { frontlineShare: 0.15 }))),
      component('roam', 'Roaming', 18, roam.score, roam.detail),
      component('deaths', 'Deaths', 16, ...pick(deathComponent(P, ctx, b))),
      component('tempo', 'Wave/vision', 10, tempo.score, tempo.detail),
      component('objectives', 'Objectives', 8, ...pick(objectiveComponent(P, ctx, b, { controlShare: 0.25 })))
    ]
  };
}

// ADC — the scaling damage carry. Damage output and positioning carry the most
// weight here because that is the entire job; lane matters less because bot lane
// outcomes are heavily driven by the support and the jungler.
function scoreAdc(P, ctx) {
  const b = BASELINE.BOTTOM;
  const opp = opponentOf(P, ctx);
  const lane = laneComponent(P, ctx, { source: 'both' });

  const economy = {
    score: pressureAdjusted(
      weightedMean([
        { score: opp ? versus(P.csPerMin, opp.csPerMin, { prior: 1.5, gain: 1.5 }) : null, weight: 0.6 },
        { score: opp ? versus(P.goldPerMin, opp.goldPerMin, { prior: 120, gain: 1.4 }) : null, weight: 0.4 }
      ]),
      P,
      3
    ),
    detail: `${P.csPerMin.toFixed(1)} cs/min · ${Math.round(P.goldPerMin)} gold/min`
  };

  const structures = {
    score: weightedMean([
      { score: opp ? versus(P.turretDamage, opp.turretDamage, { prior: 2500, gain: 1.3 }) : null, weight: 0.55 },
      { score: objectiveComponent(P, ctx, b, { controlShare: 0.25 }).score, weight: 0.45 }
    ]),
    detail: `${Math.round(P.turretDamage / 100) / 10}k turret dmg · ${P.turretTakedowns} turrets`
  };

  return {
    components: [
      component('combat', 'Damage', 28, ...pick(combatComponent(P, ctx, b, { frontlineShare: 0.1 }))),
      component('deaths', 'Positioning', 20, ...pick(deathComponent(P, ctx, b))),
      component('lane', 'Lane', laneWeight(18, ctx), lane?.score, lane?.detail),
      component('economy', 'Farming', 16, economy.score, economy.detail),
      component('structures', 'Objectives', 12, structures.score, structures.detail),
      component('presence', 'Presence', 6, ...pick(participationComponent(P, ctx, b)))
    ]
  };
}

// SUPPORT — graded on vision, making plays and being where the fights are. No
// damage expectation at all: the old score's damage-per-gold metric quietly
// punished every support who built support items, which is all of them.
function scoreSupport(P, ctx) {
  const b = BASELINE.UTILITY;
  const opp = opponentOf(P, ctx);
  const lane = laneComponent(P, ctx, { source: 'pair' });

  // Engage and peel are opposite playstyles that both count. An Alistar scores on
  // CC, a Lulu on healing and shielding — whichever they specialise in leads.
  const ccScore = opp ? versus(P.ccScore, opp.ccScore, { prior: 15, gain: 1.35 }) : null;
  const healScore = opp ? versus(P.healShieldPerMin, opp.healShieldPerMin, { prior: 120, gain: 1.35 }) : null;
  const saveScore = opp ? versus(P.savesPerGame, opp.savesPerGame, { prior: 1.2, gain: 1.3 }) : null;
  // Leaving a won bot lane to make things happen elsewhere is the support's job,
  // not a dereliction of it. Takedowns away from their own lane during laning
  // phase are counted alongside raw participation, against the enemy support who
  // had the same option.
  const participation = participationComponent(P, ctx, b);
  // Roams are only knowable from the timeline. Without one this has to drop out
  // rather than resolve to a neutral 50, which would dilute the real
  // participation signal with a number that means nothing.
  const roamScore =
    opp && ctx.hasTimeline ? versus(P.roamTakedowns, opp.roamTakedowns, { prior: 1.5, gain: 1.35 }) : null;
  const presence = {
    score: weightedMean([
      { score: participation.score, weight: 0.7 },
      { score: roamScore, weight: 0.3 }
    ]),
    detail: participation.detail + (P.roamTakedowns > 0 ? ` · ${P.roamTakedowns} roam TD` : '')
  };

  const specialised = Math.max(ccScore ?? 0, healScore ?? 0);
  const utility = {
    score:
      ccScore === null && healScore === null
        ? null
        : clamp(specialised * 0.75 + (weightedMean([{ score: ccScore, weight: 1 }, { score: healScore, weight: 1 }]) * 0.15) + (saveScore ?? 50) * 0.1, 0, 100),
    detail: `${Math.round(P.ccScore)} cc score · ${Math.round(P.healShieldPerMin)} heal+shield/min`
  };

  return {
    components: [
      component('vision', 'Vision', 28, ...pick(visionComponent(P, ctx, b))),
      component('utility', 'Utility', 22, utility.score, utility.detail),
      component('presence', 'Participation', 18, ...pick(presence)),
      component('deaths', 'Deaths', 12, ...pick(deathComponent(P, ctx, b))),
      component('lane', 'Bot lane', laneWeight(12, ctx), lane?.score, lane?.detail),
      component('objectives', 'Objectives', 8, ...pick(objectiveComponent(P, ctx, b, { controlShare: 0.3 })))
    ]
  };
}

// Fallback for ARAM, Arena, or a match where Riot's role detection failed.
// Role-neutral by necessity, and flagged as such in the output.
function scoreGeneric(P, ctx) {
  const b = BASELINE.UNKNOWN;
  return {
    components: [
      component('combat', 'Combat', 30, ...pick(combatComponent(P, ctx, b, { frontlineShare: 0.3, specialist: true }))),
      component('deaths', 'Deaths', 25, ...pick(deathComponent(P, ctx, b))),
      component('presence', 'Participation', 20, ...pick(participationComponent(P, ctx, b))),
      component('objectives', 'Objectives', 15, ...pick(objectiveComponent(P, ctx, b))),
      component('economy', 'Economy', 10, versus(P.csPerMin, b.csPerMin, { prior: 1.5, gain: 1.3 }), `${P.csPerMin.toFixed(1)} cs/min`)
    ]
  };
}

/** Spreads a `{score, detail}` result into `component()`'s trailing args. */
function pick(result) {
  return [result?.score ?? null, result?.detail ?? null];
}

const RUBRICS = {
  TOP: scoreTop,
  JUNGLE: scoreJungle,
  MIDDLE: scoreMid,
  BOTTOM: scoreAdc,
  UTILITY: scoreSupport
};

export function scoreRole(P, ctx) {
  const rubric = (ctx.isSummonersRift && RUBRICS[P.role]) || scoreGeneric;
  const { components } = rubric(P, ctx);
  return {
    composite: weightedMean(components),
    components
  };
}
