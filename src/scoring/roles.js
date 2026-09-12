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

import { versus, versusShare, fromDiff, weightedMean, blend, component, clamp, safeDiv } from './scale.js';
import { applyCalibration, globalStat, diffScale, ratioScale, hasHeadroom } from './calibration.js';

// Rough Summoner's Rift role averages. Used as the second anchor so a lane where
// both players were awful doesn't hand one of them a good score just for being
// marginally less awful.
// `killShare` is a share of the team's kills, so the five roles' figures sum to
// 1 by construction. Carries take more of them than the two roles whose job is
// to set the kill up.
// `damagePerGoldShare` is damage share over gold share — par is the role's own
// median, not 1.0, since a support's gold buys wards and a mid's buys damage.
// These five are the measured medians, kept here as the fallback for a role
// whose sample has not yet cleared the floor.
const HAND_SET_BASELINE = {
  TOP: { dmgShare: 0.21, tankShare: 0.27, kp: 0.5, lateKp: 0.555, killShare: 0.2, csPerMin: 6.4, turretDmgPerMin: 220, visionPerMin: 0.55, wDeathsPerMin: 0.2, epicShare: 0.45, damagePerGoldShare: 1.11, goldShare: 0.196, killPerDamageShare: 0.8 },
  // `jungleCs14` is jungle *monsters* by the 14-minute mark, not camps: a full
  // six-camp clear is roughly eighteen of them, so ~88 is about five clears —
  // a jungler who kept farming between plays.
  JUNGLE: { dmgShare: 0.18, tankShare: 0.21, kp: 0.62, lateKp: 0.688, killShare: 0.19, csPerMin: 5.6, jungleCs14: 88, visionPerMin: 0.9, wDeathsPerMin: 0.19, epicShare: 0.75, damagePerGoldShare: 0.87, goldShare: 0.215, killPerDamageShare: 1.24 },
  MIDDLE: { dmgShare: 0.26, tankShare: 0.17, kp: 0.58, lateKp: 0.644, killShare: 0.24, csPerMin: 7.0, turretDmgPerMin: 160, visionPerMin: 0.65, wDeathsPerMin: 0.18, epicShare: 0.5, damagePerGoldShare: 1.16, goldShare: 0.205, killPerDamageShare: 0.99 },
  // `goldPerMin` is an estimate rather than a measured figure, like `jungleCs14`
  // above: it is only used as the second anchor in a blend, so being roughly
  // right beats having no anchor at all.
  BOTTOM: { dmgShare: 0.28, tankShare: 0.15, kp: 0.56, lateKp: 0.622, killShare: 0.26, csPerMin: 7.6, goldPerMin: 460, turretDmgPerMin: 280, visionPerMin: 0.55, wDeathsPerMin: 0.17, epicShare: 0.55, damagePerGoldShare: 1, goldShare: 0.228, killPerDamageShare: 1.01 },
  // `ccScore` and `healShield` are the two axes a support can specialise on, and
  // they are bimodal by champion: an Alistar does no healing, a Soraka almost no
  // CC. Each is the bar for a support who *chose* that axis, so the higher of
  // the two is what gets graded — see `scoreSupport`.
  UTILITY: { dmgShare: 0.09, tankShare: 0.2, kp: 0.62, lateKp: 0.688, killShare: 0.11, csPerMin: 1.2, visionPerMin: 1.9, wDeathsPerMin: 0.22, epicShare: 0.4, damagePerGoldShare: 0.66, goldShare: 0.145, killPerDamageShare: 0.66, ccScore: 55, healShield: 700 },
  UNKNOWN: { dmgShare: 0.2, tankShare: 0.2, kp: 0.57, lateKp: 0.633, lateKp: 0.633, killShare: 0.2, csPerMin: 5.5, visionPerMin: 0.9, wDeathsPerMin: 0.19, epicShare: 0.5, damagePerGoldShare: 1, goldShare: 0.2, killPerDamageShare: 0.95 }
};

/**
 * The baselines the rubrics actually use.
 *
 * Every number above was hand-set, and measuring them showed several were wrong
 * by half — top and mid were held to an objectives bar more than twice the real
 * median, the ADC to a damage bar a fifth above it. A role whose measured sample
 * clears the floor runs on medians; a role that does not keeps the hand-set
 * value, because swapping a bad guess for a noisy measurement is not a fix.
 *
 * Resolved once at import: a score must not change meaning between two calls in
 * the same process.
 */
export const BASELINE = applyCalibration(HAND_SET_BASELINE);
export { HAND_SET_BASELINE };

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

// Anything measured only during laning describes a smaller share of a longer
// game. Laning is most of a 22-minute game and a prelude to a 40-minute one, so
// the weight scales with how long the game actually ran. Late-scaling champions
// were being graded as if minute 14 decided the match.
const LANE_REFERENCE_MINUTES = 27;

// How far a post-laning recovery can lift a lost lane, and how far throwing a
// lead can drag one down. Recovery is worth more than the throw is punished:
// coming back from a deficit takes play, losing a lead often takes a teamfight.
// Expressed as a share of the distance back to par rather than as a flat number
// of points.
//
// A flat ±28 was sized against a lane curve that put an ordinary 90th-percentile
// top lane at 92. Once that curve was scaled to the measured spread — p10 30,
// p90 72 — a flat 28 became 70% of the entire range, so the adjustment would
// have outweighed the thing it adjusts. A share is self-scaling: it stays
// proportionate for every role, and for any future recalibration.
//
// It also makes the ceiling structural rather than a coincidence of constants.
// The gap is measured on the head-to-head half of the lane score, since that is
// what a recovery is a statement about, and `fromDiff` is symmetric about 50 —
// so "losing lane and recovering never beats winning lane outright" reduces to
//
//     COMEBACK_SHARE < 2 x DIFFERENTIAL_WEIGHT x GOLD_WEIGHT
//
// which holds for every role and every deficit rather than needing to be
// rechecked whenever a scale moves. The gold weight is in there because the
// adjustment lands on the whole component while the gap that has to cover it is
// only the gold half. At beta 0.35 the ceiling is 0.42.
const COMEBACK_SHARE = 0.36;
const THROWN_LEAD_SHARE = 0.13;

/**
 * Scales a laning-phase component's weight by how much of the game laning was.
 *
 * Named for lanes because that is where it started, but it applies to anything
 * derived only from the first fifteen minutes — the jungler's Gank impact very
 * much included. Every input to that component (gank takedowns, lane visits,
 * unanswered pressure) stops at LANE_PHASE_MS, so leaving it at a flat weight
 * graded 18% of a 47-minute game on 15 minutes of it, while every laner's
 * equivalent metric had already shrunk to 0.57x. Same metric, same window, two
 * different rules.
 */
export function laningWeight(base, ctx) {
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
function comebackAdjustment(diff, swing, laned, { floor = 800 } = {}) {
  if (!Number.isFinite(diff) || !Number.isFinite(swing) || !Number.isFinite(laned)) return 0;
  if (diff < -floor * 0.375 && swing > 0) {
    const recovered = clamp(swing / Math.max(-diff, floor), 0, 1);
    return recovered * Math.max(0, 50 - laned) * COMEBACK_SHARE;
  }
  if (diff > floor * 0.375 && swing < 0) {
    const thrown = clamp(-swing / Math.max(diff, floor), 0, 1);
    return -thrown * Math.max(0, laned - 50) * THROWN_LEAD_SHARE;
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
function laneComponent(P, ctx, { source = 'individual' } = {}) {
  const b = BASELINE[P.role] || BASELINE.UNKNOWN;
  const net = clamp(P.netPressure ?? 0, -PRESSURE_CAP_FOR, PRESSURE_CAP_AGAINST);
  const goldPivot = -net * PRESSURE_GOLD;
  const xpPivot = -net * PRESSURE_XP;

  const individual = P.goldDiff14;
  const pair = P.pairGoldDiff14;
  let goldDiff = individual;
  // Scaled to this role's own spread rather than to one number for everyone.
  let full = diffScale(P.role, 'goldDiff14', 1800 * 2.6);
  if (source === 'pair') {
    goldDiff = pair;
    full *= 1.45;
  } else if (source === 'both' && Number.isFinite(individual) && Number.isFinite(pair)) {
    goldDiff = individual * 0.6 + (pair / 2) * 0.4;
  }
  const xpFull = diffScale(P.role, 'xpDiff14', 1400 * 2.6);

  const goldVsOpp = fromDiff(goldDiff, scaleToBench(full, P), { pivot: scaleToBench(goldPivot, P) });
  const xpVsOpp = fromDiff(P.xpDiff14, scaleToBench(xpFull, P), { pivot: scaleToBench(xpPivot, P) });

  // Did you actually lane well, independent of who you drew.
  //
  // This component was purely differential until now — the one place in the model
  // where finding 2's rule (every metric anchored to a baseline, not only to the
  // counterpart) was never applied, and it is the heaviest component in three of
  // the five rubrics. Two laners who both farmed badly went even and both scored
  // 50; two who both played a clean lane also both scored 50. The score could not
  // tell those games apart, which is the exact question the squad wants answered.
  //
  // Pressure moves this bar too, but half as far: a gank that kills you costs you
  // the gold *and* hands it to your counterpart, so it moves the difference by
  // about twice what it moves your own total.
  const benchScale = scaleToBench(1, P);
  const goldVsBar = versusShare(P.gold14, b.gold14 * benchScale + scaleToBench(goldPivot / 2, P), {
    full: ratioScale(P.role, 'gold14', 0.5)
  });
  const xpVsBar = versusShare(P.xp14, b.xp14 * benchScale + scaleToBench(xpPivot / 2, P), {
    full: ratioScale(P.role, 'xp14', 0.38)
  });

  const goldScore = blend(goldVsOpp, goldVsBar);
  const xpScore = blend(xpVsOpp, xpVsBar);

  const laned = weightedMean([
    { score: goldScore, weight: 0.6 },
    { score: xpScore, weight: 0.4 }
  ]);
  if (goldScore === null && xpScore === null) return null;

  // What happened after laning, measured the same way the deficit was. A bot
  // lane graded on the pair's economy has to have its recovery measured on the
  // pair too, or the support is credited for their ADC's comeback and vice versa.
  const swing = source === 'pair' ? P.pairPostLaneSwing : P.postLaneSwing;
  const comeback = comebackAdjustment(goldDiff, swing, goldVsOpp, { floor: source === 'pair' ? 1200 : 800 });

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
  return { score: blend(vsOpp, vsBase), detail };
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
// Did the damage convert? Kills taken as a proportion of damage done, rather
  // than kill share on its own.
  //
  // This is the audit's F7 and the "conflicting objectives" §12.3 asks for. Kill
  // share graded independently pulled a fixed amount off a low number no matter
  // how the damage got there, so a mage poking a tank through a lost teamfight
  // for 46% of the team's damage scored 57 — better than an ordinary game — on
  // damage nobody died to. Riot reports no "damage that contributed to a kill",
  // so the conversion is the honest proxy.
  //
  // As a ratio the two terms pull against each other, which is the property that
  // makes the composite hard to farm: padding damage raises the denominator and
  // costs you here, while taking kills off teammates without doing damage
  // collapses the damage-share term that carries half the component. There is no
  // way to max both without actually having decided fights.
  //
  // The bar is per role and measured, because conversion is a fact about champion
  // class before it is a fact about play: a jungler converts at 1.24 and a top
  // laner at 0.80, since bruisers and tanks chip where assassins execute.
  // Absolute only, for the same reason resource conversion is — comparing it to
  // the enemy in your role reads as a comparison of who picked the assassin.
  //
  // The bar moves with game length, because the denominator does. An ADC's
  // damage share climbs with the clock while the kills available do not, so a
  // fixed bar would have read every long game as poor conversion — the same
  // defect the damage-share bar had before it was given a slope. Scaling the
  // measured median by exactly how far the expected denominator has moved leaves
  // it untouched at the 30-minute anchor and correct either side of it.
  const lengthAdjust = baseline.dmgShare > 0 ? baseline.dmgShare / expectedDmgShare(P, ctx, baseline) : 1;
  const killConversion =
    P.killShare == null || !(P.teamDamageShare > 0)
      ? null
      : versusShare(P.killShare / P.teamDamageShare, baseline.killPerDamageShare * lengthAdjust, {
          full: ratioScale(P.role, 'killPerDamageShare', 1.2)
        });

  const dmgScore =
    P.teamDamageShare == null ? null : versusShare(P.teamDamageShare, expectedDmgShare(P, ctx, baseline), { full: ratioScale(P.role, 'dmgShare', 0.75) });
  const tankScore = P.teamTakenShare == null ? null : versusShare(P.teamTakenShare, baseline.tankShare, { full: ratioScale(P.role, 'tankShare', 1.0) });

  // An above-par damage claim is only worth what it converted.
  //
  // This is the multiplicative half of §12.3's conflicting objectives, and it is
  // needed because an additive term was not enough on its own. Damage volume
  // reaches this component three times — damage share, damage per gold and
  // damage per minute are the same underlying quantity wearing three hats — so a
  // single 20%-weight conversion term gets outvoted by its own denominator. A
  // mage padding 46% of the team's damage into a tank still scored 56, above an
  // ordinary game, while kill conversion already read 17 out of 100.
  //
  // Applied to the damage term rather than to the combined share, so a tank's
  // damage-taken claim is untouched: discounting "I was the frontline" by "I did
  // not get the kills" would be answering a question nobody asked. And applied
  // for every role, not only the ones that also score conversion as its own
  // term — a top laner opts out of that vote, which made padding worth 46 points
  // of combat score there before this existed.
  //
  // Only above-par volume is damped, and only downward. Below par the damage
  // term is already saying the player did too little, and letting poor
  // conversion pull it *up* toward 50 would reward doing nothing, which is the
  // opposite exploit.
  // The factor is the raw conversion ratio against par, not the conversion
  // *score*. The score runs through tanh and so compresses: a player converting
  // at a fifth of par still scores 21 there, which as a multiplier leaves most
  // of an inflated damage claim standing. The ratio says what it means — your
  // damage counted in proportion to how much of it converted, capped at par so
  // converting well can never inflate the claim beyond what the damage was.
  const conversionVsPar =
    killConversion === null || !(baseline.killPerDamageShare > 0) || !(P.teamDamageShare > 0)
      ? null
      : clamp(P.killShare / P.teamDamageShare / (baseline.killPerDamageShare * lengthAdjust), 0, 1);
  // Applied to every term that is a damage-volume claim, not just the first one.
  // Damage share, damage per gold and damage per minute are the same number
  // divided by three different things, so discounting one and leaving the others
  // moves the exploit rather than closing it — padding the damage figure still
  // bought 30 combat points through damage-per-gold alone.
  const discount = (score) =>
    score !== null && score > 50 && conversionVsPar !== null && conversionVsPar < 1
      ? 50 + (score - 50) * conversionVsPar
      : score;

  const convertedDmg = discount(dmgScore);

  let shareScore = weightedMean([
    { score: convertedDmg, weight: 1 - frontlineShare },
    { score: tankScore, weight: frontlineShare }
  ]);
  if (dmgScore === null && tankScore === null) shareScore = null;
  else if (specialist) {
    // 0.9 so a specialist still can't quite match someone strong at both.
    shareScore = Math.max(shareScore, Math.max(convertedDmg ?? 0, tankScore ?? 0) * 0.9);
  }

  const dpmScore = useDpm && opp ? versus(P.dpm, opp.dpm, { prior: 60, gain: 1.25 }) : null;

  // What you did with what you got, rather than how much you got.
  //
  // This is the audit's F4: nearly every raw metric is contaminated by whether
  // the team was ahead, so the score partly measures "did your team win" and
  // then benches whoever was on the wrong side of a snowball they did not cause.
  // Damage share and damage per minute both rise when you are winning, because
  // you have more items.
  //
  // Dividing damage share by gold share removes the resource advantage and
  // leaves the conversion. It measures clean: winners' median is 0.980 and
  // losers' 0.979, a ratio of 1.001, the flattest of any metric in the model.
  // It is also the one that answers "he was fed" versus "he was carrying" —
  // being given 30% of the team's gold and doing 30% of its damage is par, and
  // doing 40% on the same gold is not.
  //
  // It takes weight from `dpmScore` deliberately. Damage per minute is damage
  // share multiplied by the team's total damage, so grading both double-counts
  // the share (finding F3) and the only thing the second copy adds is how much
  // damage the two teams did — a property of the game, not of the player.
  // Graded against the bar only, with no head-to-head half — the one metric in
  // the model that is deliberately not blended.
  //
  // Two reasons, and both are arguments the model already makes elsewhere.
  // Comparing conversion to the enemy in your role is a comparison of champion
  // classes rather than of play: a Soraka and a Pyke turn gold into champion
  // damage at completely different rates by design, and grading that head-to-head
  // is the matchup-dependence bug that farming already had. And the point of the
  // metric is to be independent of how the game went, which a comparison against
  // someone else's game is not.
  //
  // The bar is derived rather than stored: damage share divided by gold share,
  // which makes it inherit the game-length slope that damage share already has.
  // An ADC's damage share climbs with the clock while their gold share does not,
  // so a stored constant would have marked down every short game.
  const conversionBar = baseline.goldShare > 0 ? expectedDmgShare(P, ctx, baseline) / baseline.goldShare : null;
  const conversionScore =
    P.damagePerGoldShare == null || conversionBar == null
      ? null
      : versusShare(P.damagePerGoldShare, conversionBar, {
          full: ratioScale(P.role, 'damagePerGoldShare', 0.8)
        });



  // Were you in the fights that decided the game. Damage share is a whole-game
  // figure and cannot tell a jungler who dominated skirmishes before 15 from one
  // who mattered at the barons — and for a jungler that distinction is the job.
  // A farming jungler cannot fake this the way they can fake a damage number.
  const lateScore =
    P.lateKp == null ? null : versusShare(P.lateKp, baseline.lateKp * (P.teamAvgKp ? clamp(P.teamAvgKp / TYPICAL_TEAM_AVG_KP, 0.6, 1.4) : 1), { full: ratioScale(P.role, 'lateKp', 0.6) });

  // Weights need not sum to 1 — weightedMean renormalises, so opting a role into
  // an extra term dilutes the others rather than needing them restated.
  const score = weightedMean([
    { score: shareScore, weight: 0.5 },
    { score: discount(conversionScore), weight: 0.28 },
    { score: discount(dpmScore), weight: 0.22 },
    { score: killConversion, weight: killShareWeight },
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
function objectiveComponent(P, ctx, baseline, { controlShare = 0.3, turretShare = 0.15 } = {}) {
  const opp = opponentOf(P, ctx);

  // Against the counterpart first: "did you show up for objectives more than the
  // player in your role on the other team" survives a game where nobody took any.
  const vsOpp = opp ? versus(P.personalEpics, opp.personalEpics, { prior: 1.2, gain: 1.3 }) : null;
  // Null rather than a constant where the bar has no headroom — see hasHeadroom.
  // `blend` then falls back to the head-to-head alone, which for a jungler is
  // the half that actually varies.
  let shareScore =
    P.epicShare == null || !hasHeadroom(P.role, 'epicShare')
      ? null
      : versusShare(P.epicShare, baseline.epicShare, { full: ratioScale(P.role, 'epicShare', 0.9) });
  // With only one or two epics on the board, "you weren't on it" is noise, not a
  // verdict. Shrink toward neutral until there's enough on the board to judge.
  if (shareScore !== null && P.teamEpicWeighted != null) {
    const confidence = clamp(P.teamEpicWeighted / 4, 0, 1);
    shareScore = 50 + (shareScore - 50) * confidence;
  }
  const involvement = blend(vsOpp, shareScore);

  const controlScore = P.teamEpicControl == null ? null : clamp(50 + (P.teamEpicControl - 0.5) * 100 * 1.2, 0, 100);
  // Anchored like every other comparison, where a baseline exists for the role.
  const turretScore = blend(
    opp ? versus(P.turretDamage, opp.turretDamage, { prior: 1500, gain: 1.3 }) : null,
    baseline.turretDmgPerMin
      ? versus(P.turretDamage, baseline.turretDmgPerMin * ctx.minutes, { prior: 1500, gain: 1.3 })
      : null
  );

  let score = weightedMean([
    { score: involvement, weight: Math.max(0, 1 - controlShare - turretShare) },
    { score: controlScore, weight: controlShare },
    { score: turretScore, weight: turretShare }
  ]);
  if (P.epicSteals > 0) score = clamp(score + Math.min(P.epicSteals, 2) * 3, 0, 100);

  const soul = P.tookSoul ? ' · soul' : P.concededSoul ? ' · conceded soul' : '';
  const detail =
    P.teamEpicControl == null
      ? `${P.personalEpics.toFixed(1)} objective takedowns`
      : `${Math.round((P.epicShare ?? 0) * 100)}% of team's · team held ${Math.round(P.teamEpicControl * 100)}%${soul}`;
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
    { score: blend(vsOpp, vsBase), weight: 0.5 },
    { score: cwScore, weight: 0.25 },
    { score: clearScore, weight: 0.25 }
  ]);
  return { score, detail: `${P.visionPerMin.toFixed(2)} vis/min · ${P.controlWards} pinks` };
}

// Average kill participation across a team in a typical game. The participation
// bar is rescaled by how a particular game spread its kills, relative to this.
//
// It was reasoned to 0.55 from "roughly 1.8 assists per kill over five players".
// Measured across 976 team-sides it is 0.467, and being 15% high shrank the bar
// in every game, inflating everyone's participation score — TOP's Presence came
// out 33 points above par in a lobby where every player sat exactly on their
// role's median.
const TYPICAL_TEAM_AVG_KP = globalStat('teamAvgKp', 0.55);

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

  const overall = versusShare(P.kp, expected, { full: ratioScale(P.role, 'kp', 0.6) });
  // Post-15 participation runs higher than overall KP, by a different factor per
  // role, so it gets its own bar rather than borrowing the overall one.
  const lateExpected = baseline.lateKp * spread;
  const late = P.lateKp == null ? null : versusShare(P.lateKp, lateExpected, { full: ratioScale(P.role, 'lateKp', 0.6) });
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

  // Scaled from the measured spread of team lane state, like the laners' own
  // lane curves. A hand-set 3200 put an ordinary 4800g team deficit at 3.5 out
  // of 100 — the same over-sharpness the individual lane curves had.
  const base = fromDiff(P.weightedLaneGold14, scaleToBench(diffScale('JUNGLE', 'teamLaneGoldDiff14', 9500), P));
  const comeback = comebackAdjustment(P.weightedLaneGold14, P.weightedLanePostSwing, base, { floor: 2600 });
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
    `${P.counterJungleCs} off their jungle` +
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
        // Early plates only. The schema probe found 70.7% of plate events now
        // land after 14:00, because plates persist and tier 2 and 3 turrets
        // carry them too — so the whole-game total is a split-push metric, not a
        // lane-dominance one. Without a timeline the phase is unknowable, and
        // the term drops out rather than asserting a lane result it cannot see.
        {
          score:
            P.platesPhaseKnown && opp?.platesPhaseKnown
              ? versus(P.platesEarly, opp.platesEarly, { prior: 2.5, gain: 1.4 })
              : null,
          weight: 0.45
        },
        {
          score: blend(
            opp ? versus(P.turretDamage, opp.turretDamage, { prior: 2000, gain: 1.3 }) : null,
            versus(P.turretDamage, b.turretDmgPerMin * ctx.minutes, { prior: 2000, gain: 1.3 })
          ),
          weight: 0.35
        },
        { score: opp ? versus(P.soloKills, opp.soloKills, { prior: 1.2, gain: 1.4 }) : null, weight: 0.2 }
      ]),
      P
    ),
    detail: `${P.platesPhaseKnown ? `${P.platesEarly} early plates` : `${P.platesTaken} plates`} · ${Math.round(P.turretDamage / 100) / 10}k turret dmg`
  };

  return {
    components: [
      component('lane', 'Lane', laningWeight(25, ctx), lane?.score, lane?.detail),
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
  // The only component that used to be graded purely head-to-head, with no
  // baseline anchor — so a good clear scored badly against a Karthus or a
  // Shyvana and a poor one scored well against a Rammus, neither of which says
  // anything about the jungler. Every other component in the model already
  // blends the counterpart against the role baseline; this now does too.
  const clearBar = scaleToBench(b.jungleCs14, P);
  const economy = {
    score: weightedMean([
      {
        score: blend(
          opp ? versus(P.jungleCs14, opp.jungleCs14, { prior: 8, gain: 1.4 }) : null,
          versus(P.jungleCs14, clearBar, { prior: 8, gain: 1.4 })
        ),
        weight: 0.55
      },
      {
        score: blend(
          opp ? versus(P.csPerMin, opp.csPerMin, { prior: 1.5, gain: 1.4 }) : null,
          versus(P.csPerMin, b.csPerMin, { prior: 1.5, gain: 1.4 })
        ),
        weight: 0.45
      }
    ]),
    // "camps" was wrong and made the number look absurd: Riot counts individual
    // monsters (its own field is enemyJungleMonsterKills), and a full six-camp
    // clear is about eighteen of them.
    detail: `${P.csPerMin.toFixed(1)} cs/min · ${P.jungleCs14} jg cs @${P.benchMinute ?? 14}`
  };

  return {
    components: [
      // Jungle was the only non-support role where fighting was a *minority* of
      // the grade: 24% against 46% for top, 43% for mid and 51% for the ADC. The
      // premise that a jungler is judged on macro is right, but taken that far it
      // meant a genuinely dominant fighting game moved the composite by 1.4
      // points where the same game as mid moved it 3.4. Macro is still most of
      // the grade at 69%; fighting is no longer an outlier at 31%.
      //
      // Safe because the farming-jungler fixture barely moves (30.0 -> 30.5): a
      // jungler who contests nothing scores badly on Teamfight too, and post-15
      // participation is the half of it they cannot fake.
      component('objectives', 'Objectives', 20, ...pick(objectiveComponent(P, ctx, b, { controlShare: 0.5 }))),
      // Scaled by game length for the same reason every laner's Lane is: it is
      // built entirely from the first fifteen minutes. In a 47-minute game this
      // drops to 10, because fifteen minutes of a forty-seven minute game is
      // not 18% of what happened — and in a 22-minute stomp it rises, because
      // then it very nearly is.
      component('pressure', 'Gank impact', laningWeight(16, ctx), pressure.score, pressure.detail),
      component('tempo', 'Tempo & map control', 16, tempo.score, tempo.detail),
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
        22,
        ...pick(combatComponent(P, ctx, b, { frontlineShare: 0.35, specialist: true, killShareWeight: 0.3, lateWeight: 0.35 }))
      ),
      component('economy', 'Jungle farm', 7, economy.score, economy.detail),
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
      {
        // Anchored to the baseline as well, as everywhere else.
        score: pressureAdjusted(
          blend(
            opp ? versus(P.csPerMin, opp.csPerMin, { prior: 1.5, gain: 1.4 }) : null,
            versus(P.csPerMin, b.csPerMin, { prior: 1.5, gain: 1.4 })
          ),
          P,
          3
        ),
        weight: 0.6
      },
      { score: visionComponent(P, ctx, b).score, weight: 0.4 }
    ]),
    detail: `${P.csPerMin.toFixed(1)} cs/min · ${P.visionPerMin.toFixed(2)} vis/min`
  };

  return {
    components: [
      component('lane', 'Lane', laningWeight(24, ctx), lane?.score, lane?.detail),
      // The other assassin lane: Zed and Talon convert far less total damage
      // into far more kills than a mage chipping a whole teamfight does. Lighter
      // than jungle's, because Roaming already measures participation here.
      component('combat', 'Damage', 24, ...pick(combatComponent(P, ctx, b, { frontlineShare: 0.15, killShareWeight: 0.2 }))),
      component('roam', 'Roaming', 18, roam.score, roam.detail),
      component('deaths', 'Deaths', 16, ...pick(deathComponent(P, ctx, b))),
      component('tempo', 'Wave/vision', 10, tempo.score, tempo.detail),
      component('objectives', 'Objectives', 8, ...pick(objectiveComponent(P, ctx, b, { controlShare: 0.25, turretShare: 0.45 })))
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
        // Anchored to the role baseline as well as the counterpart, the same way
        // jungle farm is. Pure head-to-head made this a verdict on who the enemy
        // ADC picked: an Ezreal opposite a Jinx on 10.7 cs/min scores 34 for a
        // 6.7 that is only a little under par, and the same 6.7 opposite a
        // Draven would have scored well.
        {
          score: blend(
            opp ? versus(P.csPerMin, opp.csPerMin, { prior: 1.5, gain: 1.5 }) : null,
            versus(P.csPerMin, b.csPerMin, { prior: 1.5, gain: 1.5 })
          ),
          weight: 0.6
        },
        {
          score: blend(
            opp ? versus(P.goldPerMin, opp.goldPerMin, { prior: 120, gain: 1.4 }) : null,
            versus(P.goldPerMin, b.goldPerMin, { prior: 120, gain: 1.4 })
          ),
          weight: 0.4
        }
      ]),
      P,
      3
    ),
    detail: `${P.csPerMin.toFixed(1)} cs/min · ${Math.round(P.goldPerMin)} gold/min`
  };

  const structures = {
    score: weightedMean([
      {
        // Anchored, like every other comparison. Turret damage is as
        // champion-determined as farm is - a Jinx shreds towers, an Ezreal does
        // not - and unanchored it swung this component 23 points on the enemy
        // ADC's pick alone.
        score: blend(
          opp ? versus(P.turretDamage, opp.turretDamage, { prior: 2500, gain: 1.3 }) : null,
          versus(P.turretDamage, b.turretDmgPerMin * ctx.minutes, { prior: 2500, gain: 1.3 })
        ),
        weight: 0.55
      },
      { score: objectiveComponent(P, ctx, b, { controlShare: 0.25 }).score, weight: 0.45 }
    ]),
    detail: `${Math.round(P.turretDamage / 100) / 10}k turret dmg · ${P.turretTakedowns} turrets`
  };

  return {
    components: [
      // Kill share was withheld here on the reasoning that a marksman's damage
      // already tracks their kills. It does not reliably: a poke ADC racks up
      // chip damage that killed nobody, and a burst one converts less damage
      // into more kills. An Ezreal on 32% of his team's kills and 27% of its
      // damage is the case — the two disagree, which is precisely what kill
      // share exists to catch, and it was the only carry role that could not.
      component('combat', 'Damage', 28, ...pick(combatComponent(P, ctx, b, { frontlineShare: 0.1, killShareWeight: 0.2 }))),
      component('deaths', 'Positioning', 20, ...pick(deathComponent(P, ctx, b))),
      component('lane', 'Lane', laningWeight(18, ctx), lane?.score, lane?.detail),
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
  // Measured against what a support who specialises in that axis actually does,
  // not against whatever the enemy happened to pick. Comparing head-to-head only
  // was the single most matchup-dependent thing in the model: a Soraka opposite
  // an Ashe support scored ~100 here — 22% of the grade, maxed in champion
  // select — because Ashe heals nothing, and the same Soraka opposite a Lulu
  // would have scored around 50 for an identical game.
  // Absolute only, with no head-to-head half — for the same reason the combat
  // rubric grades resource conversion absolutely.
  //
  // Adding the baseline fixed most of this, but the 35% that stayed head-to-head
  // still carried the whole problem: across a realistic champion spread the
  // head-to-head half alone swings about 70 points, which at beta 0.35 is the 22
  // this component moved on the enemy pick. Cross-champion variance in CC and
  // healing dwarfs within-champion variance, so that comparison is reading
  // champion select, not play. An Alistar "beats" a Soraka on CC in every game
  // either of them will ever play.
  //
  // Grading each axis against what a support who *chose* that axis does, and
  // then taking the axis they actually specialised in, already handles champion
  // class properly. The head-to-head half only undid it.
  // Each axis against what a support who *chose* that axis does, never against
  // the enemy support's figure on that axis.
  const axisScores = (pl) =>
    pl == null
      ? null
      : {
          cc: versus(pl.ccScore, b.ccScore, { prior: 15, gain: 1.35 }),
          heal: versus(pl.healShieldPerMin, b.healShield, { prior: 120, gain: 1.35 })
        };
  const mineAxes = axisScores(P);
  const ccScore = mineAxes.cc;
  const healScore = mineAxes.heal;
  const ccVsBar = ccScore;
  const healVsBar = healScore;
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

  // Which axis they specialised in is decided by the *absolute* figures — by what
  // they actually did — and only then compared to the enemy support on that same
  // axis.
  //
  // Taking the max of the two blended scores instead let champion select pick the
  // axis: an enemy support weak on both raises both head-to-head halves at once,
  // and the max then selects whichever rose furthest. That compounding made this
  // component swing 22 points on the enemy pick alone, at 22% of the grade —
  // four times the matchup dependence of any other component in the model, and
  // the whole of the support rubric's.
  // Both sides are 0-100 scores against the same bars, so a realistic gap is a
  // p90 support against a p10 one: about 42 points. Scaled by the same rule as
  // every other curve, that lands at 72 rather than at 84.
  const SPECIALIST_GAP_FULL = 98;
  const bestAxis = (a) => (a == null ? null : Math.max(a.cc ?? 0, a.heal ?? 0));
  const mineBest = bestAxis(mineAxes);
  const theirBest = bestAxis(axisScores(opp));

  // The head-to-head question for a support is not "did you land more CC than
  // them" — across champion classes that has no answer, and asking it anyway is
  // how this component came to swing 22 points on the enemy pick. It is "did you
  // play your class better than they played theirs". Both sides are already
  // graded against the same bars, so the two specialist scores are directly
  // comparable in a way the raw figures are not: an Alistar's CC against a
  // Soraka's healing, each measured against what a good one of those does.
  const specialised = blend(theirBest == null ? null : fromDiff(mineBest - theirBest, SPECIALIST_GAP_FULL), mineBest);
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
      component('lane', 'Bot lane', laningWeight(12, ctx), lane?.score, lane?.detail),
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
