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
// `killShare` is a share of the team's kills, so the five roles' figures sum to
// 1 by construction. Carries take more of them than the two roles whose job is
// to set the kill up.
export const BASELINE = {
  TOP: { dmgShare: 0.21, tankShare: 0.27, kp: 0.5, killShare: 0.2, csPerMin: 6.4, visionPerMin: 0.55, wDeathsPerMin: 0.2, epicShare: 0.45 },
  JUNGLE: { dmgShare: 0.18, tankShare: 0.21, kp: 0.62, killShare: 0.19, csPerMin: 5.6, visionPerMin: 0.9, wDeathsPerMin: 0.19, epicShare: 0.75 },
  MIDDLE: { dmgShare: 0.26, tankShare: 0.17, kp: 0.58, killShare: 0.24, csPerMin: 7.0, visionPerMin: 0.65, wDeathsPerMin: 0.18, epicShare: 0.5 },
  BOTTOM: { dmgShare: 0.28, tankShare: 0.15, kp: 0.56, killShare: 0.26, csPerMin: 7.6, visionPerMin: 0.55, wDeathsPerMin: 0.17, epicShare: 0.55 },
  UTILITY: { dmgShare: 0.09, tankShare: 0.2, kp: 0.62, killShare: 0.11, csPerMin: 1.2, visionPerMin: 1.9, wDeathsPerMin: 0.22, epicShare: 0.4 },
  UNKNOWN: { dmgShare: 0.2, tankShare: 0.2, kp: 0.57, killShare: 0.2, csPerMin: 5.5, visionPerMin: 0.9, wDeathsPerMin: 0.19, epicShare: 0.5 }
};

// Damage share is not a constant across a game's length. A marksman with one
// item does a fraction of the damage they do with five; a bruiser or a tank is
// nearest their peak early and fades. Grading both against one fixed number
// marks every ADC down in a short game and every top laner up, which is a
// verdict on the clock rather than on the player.
//
// `dmgShare` in BASELINE stays the figure expected at 30 minutes; the slope is
// the shift per ten minutes either side of that. The slopes are deliberately
// conservative — they estimate a real and well-established effect, and
// under-correcting leaves a small residual bias where over-correcting would
// invent the opposite one and start rewarding ADCs for short games.
const DMG_SHARE_SLOPE = {
  TOP: -0.015,
  JUNGLE: -0.009,
  MIDDLE: 0.003,
  BOTTOM: 0.032,
  UTILITY: 0,
  UNKNOWN: 0
};
const DMG_SHARE_ANCHOR_MINUTES = 30;

/** The damage share this role is expected to do in a game of this length. */
export function expectedDmgShare(P, ctx, baseline) {
  const slope = DMG_SHARE_SLOPE[P.role] ?? 0;
  const mins = clamp(ctx.minutes, 18, 45);
  return clamp(baseline.dmgShare + (slope * (mins - DMG_SHARE_ANCHOR_MINUTES)) / 10, 0.05, 0.5);
}

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
function combatComponent(
  P,
  ctx,
  baseline,
  { frontlineShare = 0.2, specialist = false, useDpm = true, killShareWeight = 0, lateWeight = 0 } = {}
) {
  const opp = opponentOf(P, ctx);
  const dmgScore =
    P.teamDamageShare == null ? null : versus(P.teamDamageShare, expectedDmgShare(P, ctx, baseline), { prior: 0.03, gain: 1.25 });
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

  // How much of the team's killing was you. Damage share alone misses this from
  // both directions: an assassin converts less total damage into more kills, and
  // a mage chipping a whole teamfight racks up damage that killed nobody. Kept
  // deliberately minor — kills are noisy and the model exists to get away from
  // grading on KDA, so this corrects damage share rather than competing with it.
  const killScore =
    P.killShare == null
      ? null
      : blend(
          opp && opp.killShare != null ? versus(P.killShare, opp.killShare, { prior: 0.06, gain: 1.25 }) : null,
          versus(P.killShare, baseline.killShare, { prior: 0.06, gain: 1.25 }),
          0.45
        );

  // Were you in the fights that decided the game. Damage share is a whole-game
  // figure and cannot tell a jungler who dominated skirmishes before 15 from one
  // who mattered at the barons — and for a jungler that distinction is the job.
  // A farming jungler cannot fake this the way they can fake a damage number.
  const lateScore =
    P.lateKp == null ? null : versus(P.lateKp, baseline.kp * (P.teamAvgKp ? clamp(P.teamAvgKp / TYPICAL_TEAM_AVG_KP, 0.6, 1.4) : 1), { prior: 0.1, gain: 1.2 });

  // Weights need not sum to 1 — weightedMean renormalises, so opting a role into
  // an extra term dilutes the others rather than needing them restated.
  const score = weightedMean([
    { score: shareScore, weight: 0.62 },
    { score: dpmScore, weight: 0.38 },
    { score: killScore, weight: killShareWeight },
    { score: lateScore, weight: lateWeight }
  ]);
  const detail =
    P.teamDamageShare == null
      ? null
      : `${Math.round(P.teamDamageShare * 100)}% team dmg` +
        (killShareWeight > 0 && P.killShare != null ? ` · ${Math.round(P.killShare * 100)}% of kills` : '') +
        (lateWeight > 0 && P.lateKp != null ? ` · ${Math.round(P.lateKp * 100)}% post-15` : '');
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

/**
 * The jungler's tempo grade. Replaces a flat "how were my four lanes doing at
 * 14 minutes", which was the only component in any rubric where the score was
 * set almost entirely by other people — and symmetric with the enemy jungler,
 * so a laner running it down handed the other jungler credit for it.
 *
 * The three parts are decisions only the jungler makes:
 *
 *   * which objectives to trade for which, when both sides are taking something
 *   * whether the enemy's jungle is theirs to keep
 *   * which lanes their presence actually reached, and what happened there
 *
 * The last of those keeps the honest half of the old component. Lane state
 * still counts, but weighted by where the jungler was, so camping a lane to a
 * win is credited and a lane that won without them is only partly theirs.
 */
function tempoComponent(P, ctx) {
  const opp = opponentOf(P, ctx);

  // Value won against value given up, across objectives both teams took on
  // opposite sides of the map inside the same window. With no trades on the
  // board this drops out rather than resolving to a neutral 50 — a game where
  // nobody traded says nothing about whether you trade well.
  const trades = P.tradeCount > 0 ? versus(P.tradeValueWon, P.tradeValueLost, { prior: 1.2, gain: 1.4 }) : null;

  // Control of the enemy jungle, not just farm taken from it. Camps alone read
  // backwards: a jungler who cleared 24 of your camps and died five times doing
  // it scored as winning the invade war, and the jungler who killed them there
  // scored as losing it. Takedowns and deaths are priced in camps so they can be
  // netted against the camp count.
  const counter =
    opp && P.jungleControl != null && opp.jungleControl != null
      ? versus(P.jungleControl, opp.jungleControl, { prior: 4, gain: 1.3 })
      : opp
        ? versus(P.counterJungleCs, opp.counterJungleCs, { prior: 4, gain: 1.3 })
        : null;

  const comeback = comebackAdjustment(P.weightedLaneGold14, P.weightedLanePostSwing, { floor: 2600 });
  const base = fromDiff(P.weightedLaneGold14, scaleToBench(3200, P));
  const lanes = base === null ? null : clamp(base + comeback, 0, 100);

  const score = weightedMean([
    { score: trades, weight: 0.4 },
    { score: counter, weight: 0.3 },
    { score: lanes, weight: 0.3 }
  ]);

  // Name the lane they lived in, when there was one. It is the whole reason the
  // lane figure is weighted the way it is, so the detail line should say it.
  const presence = P.lanePresence;
  const seen = presence ? presence.TOP + presence.MIDDLE + presence.BOTTOM : 0;
  const dominant =
    seen >= 3
      ? Object.entries(presence)
          .filter(([, n]) => n / seen > 0.5)
          .map(([zone]) => zone.toLowerCase())[0]
      : null;

  const parts = [];
  if (P.weightedLaneGold14 != null) {
    parts.push(
      `lanes ${P.weightedLaneGold14 >= 0 ? '+' : ''}${Math.round(P.weightedLaneGold14)}g @${P.benchMinute ?? 14}` +
        (dominant ? ` (mostly ${dominant})` : '') +
        comebackDetail(comeback, P.weightedLanePostSwing)
    );
  }
  if (P.tradeCount > 0) {
    parts.push(`traded ${P.tradeValueWon.toFixed(1)} for ${P.tradeValueLost.toFixed(1)}`);
  }
  // Say what actually went into the invade figure, or the camp count on its own
  // reads as the whole story again.
  parts.push(
    `${P.counterJungleCs} enemy camps` +
      (P.enemyJunglerTakedowns > 0 ? ` · ${P.enemyJunglerTakedowns} on their jungler` : '') +
      (P.invadeDeaths > 0 ? ` · ${P.invadeDeaths} died deep` : '')
  );

  return { score, detail: parts.join(' · ') };
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

  const tempo = tempoComponent(P, ctx);

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
    // Show the credit as well as the debt, so "3.3 unanswered" doesn't read as
    // an accusation when two of it was worked off by committing elsewhere.
    detail:
      `${P.gankTakedowns} gank takedowns` +
      (P.alliesUnanswered != null ? ` · ${P.alliesUnanswered.toFixed(1)} unanswered` : '') +
      (P.lanesAnswered > 0.3 ? ` (${P.lanesLeftHanging.toFixed(1)} less ${P.lanesAnswered.toFixed(1)} answered)` : '')
  };

  // Counter-jungling has moved out to Tempo, where it belongs: taking the
  // enemy's camps is a tempo act, not a farming one. What is left here is pure
  // efficiency — did you clear your own jungle as fast as they cleared theirs.
  const economy = {
    score: weightedMean([
      { score: opp ? versus(P.jungleCs14, opp.jungleCs14, { prior: 8, gain: 1.4 }) : null, weight: 0.55 },
      { score: opp ? versus(P.csPerMin, opp.csPerMin, { prior: 1.5, gain: 1.4 }) : null, weight: 0.45 }
    ]),
    detail: `${P.csPerMin.toFixed(1)} cs/min · ${P.jungleCs14} camps @${P.benchMinute ?? 14}`
  };

  return {
    components: [
      // Objectives was 24. Tempo's cross-map trades term now grades objective
      // trading directly, which overlaps the team-control half of this, so two
      // points move to the fights those objectives are contested in.
      component('objectives', 'Objectives', 22, ...pick(objectiveComponent(P, ctx, b, { controlShare: 0.5 }))),
      component('pressure', 'Gank impact', 18, pressure.score, pressure.detail),
      component('tempo', 'Tempo & map control', 17, tempo.score, tempo.detail),
      // Jungle leans on kill share hardest of any role, because it is the only
      // rubric with no participation component: without it, a jungler who took
      // 40% of their team's kills is invisible outside of damage share, which
      // understates every assassin who ever picked the role up. `lateWeight`
      // adds the post-15 fights, which is where a jungler's teamfight impact
      // actually lives — and is the half a farming jungler cannot fake, which
      // is what makes raising this weight from 12 safe.
      component(
        'combat',
        'Teamfight',
        15,
        ...pick(combatComponent(P, ctx, b, { frontlineShare: 0.35, specialist: true, killShareWeight: 0.3, lateWeight: 0.35 }))
      ),
      component('economy', 'Jungle farm', 9, economy.score, economy.detail),
      component('vision', 'Vision', 10, ...pick(visionComponent(P, ctx, b))),
      component('deaths', 'Deaths', 9, ...pick(deathComponent(P, ctx, b)))
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
      // The other assassin lane: Zed and Talon convert far less total damage
      // into far more kills than a mage chipping a whole teamfight does. Lighter
      // than jungle's, because Roaming already measures participation here.
      component('combat', 'Damage', 24, ...pick(combatComponent(P, ctx, b, { frontlineShare: 0.15, killShareWeight: 0.2 }))),
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
      // Vision was 28 and Participation 18. Vision is the most reliable thing a
      // support does, but it is also the easiest to accumulate without affecting
      // the game, and at 28 it was the single heaviest stat in the rubric.
      // Being where things happened is the better answer to "did this support
      // do anything", so four points move across.
      component('vision', 'Vision', 24, ...pick(visionComponent(P, ctx, b))),
      component('utility', 'Utility', 22, utility.score, utility.detail),
      component('presence', 'Participation', 22, ...pick(presence)),
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
