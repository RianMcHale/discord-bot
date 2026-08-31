// Derives the per-player facts the role rubrics score against.
//
// Everything that needs the match TIMELINE lives here: gold/xp state at the end
// of laning, who was actually present when someone died, which team controlled
// epic objectives, and — the important one — how much jungle pressure each laner
// received versus how much their own jungler gave them.
//
// The timeline is optional. If the call fails or the mode isn't Summoner's Rift,
// every timeline-derived field comes back null and the rubrics fall back to the
// end-of-game stats block, flagged as `dataQuality: 'partial'`.

import { clamp, safeDiv } from './scale.js';

export const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
export const SOLO_LANES = ['TOP', 'MIDDLE'];

const LANE_PHASE_MS = 15 * 60 * 1000;
const BENCH_MINUTE = 14; // end of laning — the standard checkpoint for lane state
const MAP_DIAGONAL_SUM = 15000; // x+y along the line that splits the two halves
const GANK_RADIUS = 2400; // jungler-to-laner distance that counts as "in my lane"
const TRADE_RADIUS = 3000; // two deaths this close together are the same fight
const LANE_CONTEST_RADIUS = 2900; // opponent must be there too, or it's just farming

// Weighted so "objectives taken" reflects actual macro value rather than a raw
// count. Void grubs come six at a time and are worth roughly a third of a drake
// each; barons and elders decide games.
const EPIC_WEIGHT = {
  DRAGON: 1,
  ELDER_DRAGON: 2,
  RIFTHERALD: 1,
  BARON_NASHOR: 1.5,
  HORDE: 0.34,
  ATAKHAN: 1.5
};

function epicWeight(ev) {
  if (ev.monsterType === 'DRAGON' && ev.monsterSubType === 'ELDER_DRAGON') return EPIC_WEIGHT.ELDER_DRAGON;
  return EPIC_WEIGHT[ev.monsterType] ?? 1;
}

// Two objectives taken close together on opposite sides of the map are a trade,
// not two independent plays: one team gave up the contest to take something
// elsewhere. Deciding a trade needs a side and a window, and both are cheap to
// get wrong, so the tests pin them.
const TRADE_WINDOW_MS = 45000;

// What an invade is worth, priced in jungle camps so it can be added to a camp
// count. A takedown on the enemy jungler is worth roughly three camps of tempo;
// dying on an invade costs about two.
const INVADE_TAKEDOWN_CAMPS = 3;
const INVADE_DEATH_CAMPS = 2;
const TURRET_VALUE = { OUTER_TURRET: 0.6, INNER_TURRET: 0.9, BASE_TURRET: 1.1, NEXUS_TURRET: 1.3 };

/** Which half of the map an objective sits on. Mid trades against either side. */
function objectiveSide(ev) {
  if (ev.type === 'ELITE_MONSTER_KILL') {
    if (ev.monsterType === 'DRAGON') return 'BOT';
    if (ev.monsterType === 'RIFTHERALD' || ev.monsterType === 'BARON_NASHOR' || ev.monsterType === 'HORDE') return 'TOP';
    return null; // Atakhan spawns on a variable side; not classifiable
  }
  if (ev.type === 'BUILDING_KILL') {
    if (ev.laneType === 'TOP_LANE') return 'TOP';
    if (ev.laneType === 'BOT_LANE') return 'BOT';
    if (ev.laneType === 'MID_LANE') return 'MID';
  }
  return null;
}

/** Macro value of an objective, on the same scale as EPIC_WEIGHT. */
function objectiveValue(ev) {
  if (ev.type === 'ELITE_MONSTER_KILL') return epicWeight(ev);
  return TURRET_VALUE[ev.towerType] ?? 0.6;
}

function dist(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Which lane a map position belongs to, splitting the map on the mid diagonal. */
export function laneZone(pos) {
  if (!pos) return null;
  const d = pos.x - pos.y;
  if (Math.abs(d) < 2200) return 'MIDDLE';
  return d < 0 ? 'TOP' : 'BOTTOM';
}

/** True if the position is on `teamId`'s own half of the map. */
function isOwnHalf(pos, teamId) {
  if (!pos) return false;
  const sum = pos.x + pos.y;
  return teamId === 100 ? sum < MAP_DIAGONAL_SUM : sum > MAP_DIAGONAL_SUM;
}

/** The lane a player is responsible for. Bot lane's two roles share one zone. */
function zoneForRole(role) {
  if (role === 'TOP') return 'TOP';
  if (role === 'MIDDLE') return 'MIDDLE';
  if (role === 'BOTTOM' || role === 'UTILITY') return 'BOTTOM';
  return null; // jungle roams everywhere
}

function normaliseRole(p) {
  for (const candidate of [p.teamPosition, p.individualPosition, p.lane]) {
    if (ROLES.includes(candidate)) return candidate;
  }
  return 'UNKNOWN';
}

/** Riot returned gameDuration in ms for a stretch of patches; normalise to seconds. */
function durationSeconds(info) {
  if (info.gameEndTimestamp) return info.gameDuration;
  return Math.round(info.gameDuration / 1000);
}

function frameAtMinute(frames, minute) {
  let chosen = frames[0];
  for (const f of frames) {
    if (f.timestamp <= minute * 60000 + 5000) chosen = f;
    else break;
  }
  return chosen;
}

function pf(frame, participantId) {
  return frame?.participantFrames?.[String(participantId)] || null;
}

// ---------------------------------------------------------------------------
// Death weighting
// ---------------------------------------------------------------------------

/**
 * Not all deaths are equal, and treating them as equal is the single biggest
 * reason the old score punished the wrong people. A 1v1 death in an even lane is
 * a mistake you own. Dying to a 3-man collapse while your jungler is on the
 * other side of the map is a macro failure that mostly belongs to someone else.
 *
 * Multipliers:
 *   solo (1 attacker)      1.25  — you got outplayed straight up
 *   2 attackers            1.00  — baseline gank
 *   3 attackers            0.75  — you were collapsed on
 *   4+ attackers           0.55  — that's a teamfight, not a griefing death
 *   traded within 12s      x0.6  — someone on the enemy team died too; that's a fight
 *   deep in enemy half     x1.25 — you walked into it
 *   gank before 15:00      x0.70 — the enemy jungler invested for this
 *   gave up a shutdown     x1.15 — you were fed and handed it back
 *   late game              x(1 + 0.45 * gameProgress) — death timers and stakes scale
 */
function weighDeath(ev, { gameDurationMs, victimTeamId, tradeWindowKills, enemyJunglerId }) {
  const attackers = 1 + (ev.assistingParticipantIds?.length || 0);
  let w = attackers === 1 ? 1.25 : attackers === 2 ? 1.0 : attackers === 3 ? 0.75 : 0.55;
  const tags = [attackers === 1 ? 'solo' : attackers >= 4 ? 'teamfight' : 'collapsed'];

  // A trade means someone died *in the same fight*, not merely at the same time.
  // Without the distance check, a kill on the far side of the map inside a 12
  // second window counted as a trade — so in a high-kill game nearly every death
  // was discounted 40%, and death discipline stopped separating anyone.
  const traded = tradeWindowKills.some(
    (k) =>
      k.victimTeamId !== victimTeamId &&
      Math.abs(k.timestamp - ev.timestamp) <= 12000 &&
      dist(k.position, ev.position) <= TRADE_RADIUS
  );
  if (traded) {
    w *= 0.6;
    tags.push('traded');
  }

  if (ev.position && !isOwnHalf(ev.position, victimTeamId) && attackers <= 2) {
    w *= 1.25;
    tags.push('deep');
  }

  const gankedInLane =
    ev.timestamp < LANE_PHASE_MS &&
    enemyJunglerId != null &&
    (ev.killerId === enemyJunglerId || (ev.assistingParticipantIds || []).includes(enemyJunglerId));
  if (gankedInLane) {
    w *= 0.7;
    tags.push('ganked');
  }

  if ((ev.shutdownBounty || 0) > 0) {
    w *= 1.15;
    tags.push('shutdown');
  }

  w *= 1 + 0.45 * clamp(ev.timestamp / Math.max(gameDurationMs, 1), 0, 1);

  return { weight: w, tags };
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export function buildContext(match, timeline = null) {
  const info = match.info;
  const durSec = durationSeconds(info);
  const minutes = Math.max(durSec / 60, 1);
  const gameDurationMs = durSec * 1000;
  const isSummonersRift = info.mapId === undefined || info.mapId === 11;

  const frames = timeline?.info?.frames;
  const hasTimeline = Array.isArray(frames) && frames.length > 2 && isSummonersRift;

  // participantId is 1-10 in participant order, but map through puuid to be safe.
  const players = info.participants.map((p, idx) => {
    const ch = p.challenges || {};
    const teamKills = info.participants
      .filter((q) => q.teamId === p.teamId)
      .reduce((s, q) => s + q.kills, 0);

    return {
      puuid: p.puuid,
      participantId: p.participantId ?? idx + 1,
      teamId: p.teamId,
      role: normaliseRole(p),
      champion: p.championName,
      win: p.win,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      kda: `${p.kills}/${p.deaths}/${p.assists}`,
      raw: p,
      ch,

      // --- end-of-game shares (always available) ---
      kp: Number.isFinite(ch.killParticipation)
        ? ch.killParticipation
        : safeDiv(p.kills + p.assists, teamKills, 0),
      // Share of the team's kills, as opposed to `kp`, which counts assists and
      // so rewards being present over being decisive. Damage share misses the
      // same thing from the other side: an assassin converts less total damage
      // into more kills than a mage chipping a whole teamfight does.
      //
      // Unlike kp this needs no rescaling for how the game spread its kills —
      // the five shares on a team sum to exactly 1 by construction.
      killShare: teamKills > 0 ? p.kills / teamKills : null,
      teamDamageShare: Number.isFinite(ch.teamDamagePercentage) ? ch.teamDamagePercentage : null,
      teamTakenShare: Number.isFinite(ch.damageTakenOnTeamPercentage) ? ch.damageTakenOnTeamPercentage : null,
      dpm: Number.isFinite(ch.damagePerMinute)
        ? ch.damagePerMinute
        : safeDiv(p.totalDamageDealtToChampions, minutes),
      goldPerMin: safeDiv(p.goldEarned, minutes),
      csPerMin: safeDiv((p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0), minutes),
      jungleCsPerMin: safeDiv(p.neutralMinionsKilled || 0, minutes),
      visionPerMin: Number.isFinite(ch.visionScorePerMinute)
        ? ch.visionScorePerMinute
        : safeDiv(p.visionScore, minutes),
      controlWards: ch.controlWardsPlaced ?? p.detectorWardsPlaced ?? 0,
      wardsPlacedPerMin: safeDiv(p.wardsPlaced || 0, minutes),
      wardTakedownsPerMin: safeDiv(ch.wardTakedowns ?? p.wardsKilled ?? 0, minutes),
      turretDamage: p.damageDealtToTurrets || 0,
      turretTakedowns: ch.turretTakedowns ?? p.turretTakedowns ?? 0,
      // Personal objective credit comes from the challenges block rather than the
      // timeline: `assistingParticipantIds` on ELITE_MONSTER_KILL is missing on
      // older matches, and when it is, every laner reads as 0% objective
      // involvement. These fields are always present and mean the same thing.
      personalEpics:
        (ch.dragonTakedowns || 0) +
        (ch.riftHeraldTakedowns || 0) +
        (ch.baronTakedowns || 0) * 1.5 +
        ((ch.voidMonsterKill || 0) + (ch.hordeKills || 0)) * 0.34,
      platesTaken: ch.turretPlatesTaken ?? 0,
      soloKills: ch.soloKills ?? 0,
      counterJungleCs: ch.enemyJungleMonsterKills ?? 0,
      epicSteals: (ch.epicMonsterSteals ?? 0) + (p.objectivesStolen ?? 0),
      ccScore: (p.timeCCingOthers || 0) + (ch.enemyChampionImmobilizations || 0) * 0.5,
      healShieldPerMin: safeDiv(
        ch.effectiveHealAndShielding ??
          (p.totalHealsOnTeammates || 0) + (p.totalDamageShieldedOnTeammates || 0),
        minutes
      ),
      savesPerGame: ch.saveAllyFromDeath ?? 0,

      // --- filled in below when a timeline is available ---
      counterpartPuuid: null,
      gold14: null,
      xp14: null,
      cs14: null,
      jungleCs14: null,
      goldDiff14: null,
      xpDiff14: null,
      csDiff14: null,
      pairGoldDiff14: null,
      benchMinute: null,
      pressureAgainst: 0,
      pressureFor: 0,
      netPressure: null,
      gankDeaths: 0,
      gankTakedowns: 0,
      roamTakedowns: 0,
      postLaneSwing: null,
      pairPostLaneSwing: null,
      teamPostLaneSwing: null,
      teamAvgKp: null,
      laneVisitsGiven: 0, // jungle: lane visits this player made
      weightedDeathsPerMin: null,
      deathTags: null,
      lateKp: null,
      epicCredits: 0,
      epicShare: null,
      teamEpicWeighted: null,
      teamEpicControl: null,
      teamLaneGold14: null,
      weightedLaneGold14: null,
      weightedLanePostSwing: null,
      lanePresence: null,
      tradeValueWon: 0,
      tradeValueLost: 0,
      tradeCount: 0,
      enemyJunglerTakedowns: 0,
      invadeDeaths: 0,
      jungleControl: null,
      alliesUnanswered: null,
      dataQuality: hasTimeline ? 'full' : 'partial'
    };
  });

  const byId = new Map(players.map((p) => [p.participantId, p]));
  const byPuuid = new Map(players.map((p) => [p.puuid, p]));

  // Average kill participation across each team. Kill participation is a share
  // of your own team's kills, so it compresses hard when a game produces a lot
  // of them: in a 38-kill stomp full of solo picks, nobody can be present for
  // 60% of them, and every player reads as absent against a fixed baseline.
  // This is the yardstick that says what "normal involvement" looked like in
  // THIS game — it rises in teamfight-heavy games and falls in pick-heavy ones.
  for (const teamId of [100, 200]) {
    const side = players.filter((p) => p.teamId === teamId);
    const avg = side.length ? side.reduce((s, p) => s + p.kp, 0) / side.length : null;
    side.forEach((p) => (p.teamAvgKp = avg));
  }

  // --- lane counterparts: the player whose job was identical to yours ---------
  for (const p of players) {
    if (p.role === 'UNKNOWN') continue;
    const opp = players.find((q) => q.teamId !== p.teamId && q.role === p.role);
    p.counterpartPuuid = opp ? opp.puuid : null;
  }

  const teams = {
    100: { epicWeighted: 0, kills: 0, lateKills: 0, laneGold14: 0 },
    200: { epicWeighted: 0, kills: 0, lateKills: 0, laneGold14: 0 }
  };
  for (const p of players) teams[p.teamId].kills += p.kills;

  const ctx = {
    matchId: match.metadata?.matchId || info.gameId,
    minutes,
    durationSeconds: durSec,
    queueId: info.queueId,
    isSummonersRift,
    hasTimeline,
    benchMinute: null,
    players,
    byPuuid,
    teams
  };

  if (!hasTimeline) return ctx;

  // -------------------------------------------------------------------------
  // Timeline pass
  // -------------------------------------------------------------------------
  const lastMinute = Math.floor(frames[frames.length - 1].timestamp / 60000);
  const benchMinute = Math.min(BENCH_MINUTE, Math.max(lastMinute, 1));
  ctx.benchMinute = benchMinute;
  const benchFrame = frameAtMinute(frames, benchMinute);

  for (const p of players) {
    const f = pf(benchFrame, p.participantId);
    p.benchMinute = benchMinute;
    p.gold14 = f?.totalGold ?? null;
    p.xp14 = f?.xp ?? null;
    p.cs14 = (f?.minionsKilled ?? 0) + (f?.jungleMinionsKilled ?? 0);
    p.jungleCs14 = f?.jungleMinionsKilled ?? 0;
  }

  for (const p of players) {
    const opp = p.counterpartPuuid ? byPuuid.get(p.counterpartPuuid) : null;
    if (!opp || p.gold14 == null || opp.gold14 == null) continue;
    p.goldDiff14 = p.gold14 - opp.gold14;
    p.xpDiff14 = (p.xp14 ?? 0) - (opp.xp14 ?? 0);
    p.csDiff14 = (p.cs14 ?? 0) - (opp.cs14 ?? 0);

    // Everything earned AFTER laning, measured against the same counterpart.
    // A lane snapshot at 14 minutes says nothing about a scaling champion who
    // was a thousand down then and the highest-damage player on the map by 34.
    const minePost = p.raw.goldEarned - p.gold14;
    const theirsPost = opp.raw.goldEarned - opp.gold14;
    p.postLaneSwing = minePost - theirsPost;
  }

  // Bot lane is a 2v2, so the pair's combined economy is the honest read on who
  // won it — a support who gave up every trade can't hide behind their ADC's CS.
  for (const teamId of [100, 200]) {
    const pair = players.filter((p) => p.teamId === teamId && (p.role === 'BOTTOM' || p.role === 'UTILITY'));
    const other = players.filter((p) => p.teamId !== teamId && (p.role === 'BOTTOM' || p.role === 'UTILITY'));
    if (pair.length === 2 && other.length === 2) {
      const at14 = (side) => side.reduce((s, p) => s + (p.gold14 || 0), 0);
      const post = (side) => side.reduce((s, p) => s + (p.raw.goldEarned - (p.gold14 || 0)), 0);
      pair.forEach((p) => {
        p.pairGoldDiff14 = at14(pair) - at14(other);
        // Measured on the pair, like the deficit is — otherwise a support gets
        // credited for their ADC's recovery, and the ADC for the support's.
        p.pairPostLaneSwing = post(pair) - post(other);
      });
    }
  }

  // Team lane economy at 14 — the jungler's report card. Junglers are excluded:
  // this measures the state of the map the jungler was responsible for shaping.
  for (const teamId of [100, 200]) {
    const lanes = players.filter((p) => p.teamId === teamId && p.role !== 'JUNGLE');
    teams[teamId].laneGold14 = lanes.reduce((s, p) => s + (p.gold14 || 0), 0);
    teams[teamId].laneGoldPost = lanes.reduce((s, p) => s + (p.raw.goldEarned - (p.gold14 || 0)), 0);
  }
  for (const p of players) {
    const them = teams[p.teamId === 100 ? 200 : 100];
    p.teamLaneGold14 = teams[p.teamId].laneGold14 - them.laneGold14;
    // How the map the jungler was responsible for moved after laning ended.
    p.teamPostLaneSwing = teams[p.teamId].laneGoldPost - them.laneGoldPost;
  }

  const junglers = {
    100: players.find((p) => p.teamId === 100 && p.role === 'JUNGLE') || null,
    200: players.find((p) => p.teamId === 200 && p.role === 'JUNGLE') || null
  };

  const events = frames.flatMap((f) => f.events || []);
  const kills = events
    .filter((e) => e.type === 'CHAMPION_KILL' && byId.has(e.victimId))
    .map((e) => ({ ...e, victimTeamId: byId.get(e.victimId).teamId }));

  // --- deaths, weighted by context -----------------------------------------
  const deathAgg = new Map(players.map((p) => [p.participantId, { weighted: 0, tags: {} }]));
  for (const ev of kills) {
    const victim = byId.get(ev.victimId);
    const enemyJungler = junglers[victim.teamId === 100 ? 200 : 100];
    const { weight, tags } = weighDeath(ev, {
      gameDurationMs,
      victimTeamId: victim.teamId,
      tradeWindowKills: kills,
      enemyJunglerId: enemyJungler?.participantId ?? null
    });
    const agg = deathAgg.get(ev.victimId);
    agg.weighted += weight;
    tags.forEach((t) => (agg.tags[t] = (agg.tags[t] || 0) + 1));
  }
  for (const p of players) {
    const agg = deathAgg.get(p.participantId);
    p.weightedDeathsPerMin = safeDiv(agg.weighted, minutes);
    p.deathTags = agg.tags;
  }

  // --- jungle pressure ------------------------------------------------------
  // A gank that lands shows up as a kill event. A gank that just shoves a laner
  // off the wave doesn't, so lane visits are also read off the position frames:
  // the enemy jungler standing in your lane, next to you, while your lane
  // opponent is also there. Requiring the opponent's presence is what separates
  // "camping you" from "farming the camp behind your lane".
  for (const ev of kills) {
    if (ev.timestamp >= LANE_PHASE_MS) continue;
    const victim = byId.get(ev.victimId);
    if (!victim || victim.role === 'JUNGLE' || victim.role === 'UNKNOWN') continue;
    const enemyJungler = junglers[victim.teamId === 100 ? 200 : 100];
    if (!enemyJungler) continue;
    const involved =
      ev.killerId === enemyJungler.participantId ||
      (ev.assistingParticipantIds || []).includes(enemyJungler.participantId);
    if (!involved) continue;
    victim.gankDeaths += 1;
    enemyJungler.gankTakedowns += 1;
  }

  // --- the invade war -------------------------------------------------------
  // Camps taken off the enemy jungle used to be the whole story, and it read
  // backwards: a jungler who farmed 24 of your camps and died five times doing
  // it was scored as *winning* the enemy jungle, and the jungler who killed
  // them there scored as losing it, because kills are not camps.
  //
  // The loop above cannot help — it explicitly skips jungler victims, since a
  // jungler killing the enemy jungler is not a gank on a lane. So the two
  // halves of an invade are counted here, on the whole game rather than just
  // laning phase: a fight over the enemy's raptors at 24 minutes is the same
  // event it was at 6.
  for (const ev of kills) {
    const victim = byId.get(ev.victimId);
    if (!victim) continue;

    if (victim.role === 'JUNGLE') {
      for (const id of [ev.killerId, ...(ev.assistingParticipantIds || [])]) {
        const p = byId.get(id);
        if (p && p.teamId !== victim.teamId) p.enemyJunglerTakedowns += 1;
      }
    }
    // Died on the wrong side of the map: whatever you went there for, you paid
    // for it. `isOwnHalf` is the same test the deep-death penalty already uses.
    if (ev.position && !isOwnHalf(ev.position, victim.teamId)) victim.invadeDeaths += 1;
  }

  for (const p of players) {
    if (p.role !== 'JUNGLE') continue;
    // Netted in camps, so it stays on the scale the comparison was tuned for.
    // The cost of dying is lighter than the reward for a takedown on purpose:
    // deaths are already charged for in the Deaths component, and charging the
    // full amount in both places punishes one event twice.
    p.jungleControl =
      p.counterJungleCs + INVADE_TAKEDOWN_CAMPS * p.enemyJunglerTakedowns - INVADE_DEATH_CAMPS * p.invadeDeaths;
  }

  // The mirror signal: takedowns a laner got *with* their own jungler in lane.
  // Being handed two free kills by your jungler and still ending laning even is
  // a worse result than going even with no help at all.
  const helpReceived = new Map(players.map((p) => [p.participantId, 0]));
  const roamTakedowns = new Map(players.map((p) => [p.participantId, 0]));
  for (const ev of kills) {
    if (ev.timestamp >= LANE_PHASE_MS) continue;
    const victim = byId.get(ev.victimId);
    if (!victim) continue;
    const killerTeam = victim.teamId === 100 ? 200 : 100;
    const allyJungler = junglers[killerTeam];
    const participants = [ev.killerId, ...(ev.assistingParticipantIds || [])];
    const junglerThere = allyJungler && participants.includes(allyJungler.participantId);
    const where = laneZone(ev.position);

    for (const id of participants) {
      const helper = byId.get(id);
      if (!helper || helper.teamId !== killerTeam) continue;
      const myLane = zoneForRole(helper.role);
      if (!myLane) continue; // junglers neither receive help nor "roam"

      if (where && where !== myLane) {
        // A takedown away from your own lane during laning phase. For a support
        // this is the whole point of leaving a won bot lane.
        roamTakedowns.set(id, roamTakedowns.get(id) + 1);
      } else if (junglerThere) {
        // Only a kill IN your lane counts as your jungler having helped you.
        // Without that check, any skirmish the jungler joined raised the lane bar
        // for everyone present — which hits supports hardest, since they assist
        // on nearly everything and would be permanently graded as though their
        // jungler had handed them the lane.
        helpReceived.set(id, helpReceived.get(id) + 1);
      }
    }
  }

  const visitCount = new Map(players.map((p) => [p.participantId, { against: 0, for: 0 }]));
  for (const frame of frames) {
    if (frame.timestamp > LANE_PHASE_MS) break;
    for (const laner of players) {
      const myZone = zoneForRole(laner.role);
      if (!myZone) continue;
      const me = pf(frame, laner.participantId);
      const opp = laner.counterpartPuuid ? byPuuid.get(laner.counterpartPuuid) : null;
      const oppFrame = opp ? pf(frame, opp.participantId) : null;
      if (!me?.position || !oppFrame?.position) continue;
      // The lane has to actually be contested, and it has to be my side of the map.
      if (dist(me.position, oppFrame.position) > LANE_CONTEST_RADIUS) continue;
      if (!isOwnHalf(me.position, laner.teamId)) continue;

      const enemyJ = junglers[laner.teamId === 100 ? 200 : 100];
      const allyJ = junglers[laner.teamId];
      const ej = enemyJ ? pf(frame, enemyJ.participantId) : null;
      const aj = allyJ ? pf(frame, allyJ.participantId) : null;
      const counts = visitCount.get(laner.participantId);
      if (ej?.position && dist(me.position, ej.position) <= GANK_RADIUS) {
        counts.against += 1;
        enemyJ.laneVisitsGiven += 1;
      }
      if (aj?.position && dist(me.position, aj.position) <= GANK_RADIUS) {
        counts.for += 1;
        allyJ.laneVisitsGiven += 1;
      }
    }
  }

  for (const p of players) p.roamTakedowns = roamTakedowns.get(p.participantId) ?? 0;

  // --- where the jungler actually was --------------------------------------
  // Laning-phase frames spent within gank range of each of their own lanes.
  // Unlike the pressure counters above this is not gated on the lane being
  // contested: the question here is only "were you there", not "did it land".
  const ZONES = ['TOP', 'MIDDLE', 'BOTTOM'];
  const lanePresence = new Map(
    Object.values(junglers)
      .filter(Boolean)
      .map((j) => [j.participantId, { TOP: 0, MIDDLE: 0, BOTTOM: 0 }])
  );
  for (const frame of frames) {
    if (frame.timestamp > LANE_PHASE_MS) break;
    for (const teamId of [100, 200]) {
      const j = junglers[teamId];
      if (!j) continue;
      const jf = pf(frame, j.participantId);
      if (!jf?.position) continue;
      const counted = new Set();
      for (const laner of players) {
        if (laner.teamId !== teamId) continue;
        const zone = zoneForRole(laner.role);
        if (!zone || counted.has(zone)) continue;
        const lf = pf(frame, laner.participantId);
        if (!lf?.position) continue;
        if (dist(jf.position, lf.position) <= GANK_RADIUS) {
          lanePresence.get(j.participantId)[zone] += 1;
          counted.add(zone);
        }
      }
    }
  }

  // Each lane's gold swing at 14, weighted by how much of laning the jungler
  // spent in it. A jungler who was everywhere equally — or nowhere at all —
  // gets a flat average across the three lanes, which is exactly what grading
  // the lanes as one lump already did. Camping a lane makes that lane most of
  // the grade, which is the part the lump got wrong.
  //
  // The weights are floored at 1 and capped at 3 on purpose. Positions are
  // sampled once a minute, so presence is roughly fourteen dots per game: good
  // enough to say "mostly top", never good enough to fully credit or fully
  // absolve a jungler for one lane.
  for (const teamId of [100, 200]) {
    const j = junglers[teamId];
    if (!j) continue;
    const presence = lanePresence.get(j.participantId) ?? { TOP: 0, MIDDLE: 0, BOTTOM: 0 };
    const seen = ZONES.reduce((s, z) => s + presence[z], 0);

    let num14 = 0;
    let numPost = 0;
    let den = 0;
    for (const zone of ZONES) {
      const mine = players.filter((p) => p.teamId === teamId && zoneForRole(p.role) === zone);
      const theirs = players.filter((p) => p.teamId !== teamId && zoneForRole(p.role) === zone);
      if (!mine.length || mine.length !== theirs.length) continue;
      if ([...mine, ...theirs].some((p) => p.gold14 == null)) continue;
      const at14 = (side) => side.reduce((s, p) => s + p.gold14, 0);
      const post = (side) => side.reduce((s, p) => s + (p.raw.goldEarned - p.gold14), 0);

      const w = 1 + 2 * (seen > 0 ? presence[zone] / seen : 1 / ZONES.length);
      num14 += w * (at14(mine) - at14(theirs));
      numPost += w * (post(mine) - post(theirs));
      den += w;
    }
    if (den > 0) {
      // Rescaled back to three lanes' worth of gold so it lands on the same
      // scale the flat figure used and the thresholds tuned against it hold.
      j.weightedLaneGold14 = (num14 / den) * ZONES.length;
      j.weightedLanePostSwing = (numPost / den) * ZONES.length;
      j.lanePresence = presence;
    }
  }

  for (const p of players) {
    if (!zoneForRole(p.role)) continue; // junglers don't receive lane pressure
    const v = visitCount.get(p.participantId);

    // The two directions do not deserve equal trust.
    //
    // Pressure AGAINST you is corroborated by deaths: the enemy jungler is in
    // the kill feed. Pressure FOR you is mostly inferred from position frames,
    // and "my jungler was standing nearby" is weak evidence they did anything —
    // especially in bot lane, which sits right next to the bot jungle, so a
    // jungler farming their own camps reads as a gank setup. Counting that at
    // full weight raises the bar on a laner for their jungler's pathing.
    //
    // So proximity counts fully against, a third as much for, and only landed
    // takedowns move the bar up at full strength.
    p.pressureAgainst = p.gankDeaths + Math.min(v.against, 4) * 0.6;
    // Assisted takedowns are capped too: a jungler who was there for five early
    // kills did help, but past a point it stops saying anything more about what
    // the laner was expected to achieve, and an uncapped figure reads as a much
    // bigger effect than it can actually have on the score.
    p.pressureFor = Math.min(helpReceived.get(p.participantId), 3) + Math.min(v.for, 3) * 0.3;
    p.netPressure = p.pressureAgainst - p.pressureFor;
  }

  // How much did a jungler leave their own lanes hanging? Sum of the net pressure
  // their laners ate. This is the accountability the old scoring had no way to
  // express: your top laner got camped four times, and you were never there.
  for (const teamId of [100, 200]) {
    const j = junglers[teamId];
    if (!j) continue;
    j.alliesUnanswered = players
      .filter((p) => p.teamId === teamId && p.role !== 'JUNGLE' && p.role !== 'UNKNOWN')
      .reduce((s, p) => s + Math.max(0, p.netPressure ?? 0), 0);
  }

  // --- epic objectives ------------------------------------------------------
  for (const ev of events) {
    if (ev.type !== 'ELITE_MONSTER_KILL') continue;
    const killer = byId.get(ev.killerId);
    const teamId = ev.killerTeamId || killer?.teamId;
    if (!teamId || !teams[teamId]) continue;
    const w = epicWeight(ev);
    teams[teamId].epicWeighted += w;
    const credited = new Set([ev.killerId, ...(ev.assistingParticipantIds || [])]);
    for (const id of credited) {
      const p = byId.get(id);
      if (p && p.teamId === teamId) p.epicCredits += w;
    }
  }
  for (const p of players) {
    const own = teams[p.teamId].epicWeighted;
    const other = teams[p.teamId === 100 ? 200 : 100].epicWeighted;
    p.teamEpicWeighted = own;
    // Prefer the challenges-derived personal count; fall back to timeline credits
    // when the challenges block is missing them entirely.
    const credits = p.personalEpics > 0 ? p.personalEpics : p.epicCredits;
    p.epicShare = own > 0 ? clamp(credits / own, 0, 1) : null;
    p.teamEpicControl = own + other > 0 ? own / (own + other) : null;
  }

  // --- cross-map objective trades -------------------------------------------
  // Taking herald while they take drake is a trade, and making it — or refusing
  // it — is a jungle decision. Scored on value won against value given up,
  // which is a different question from who took more objectives overall; that
  // is what team epic control already answers.
  const teamOfTake = (ev) => {
    const killer = byId.get(ev.killerId);
    if (ev.type === 'BUILDING_KILL') {
      // `teamId` on a building kill is the team that *owned* it. Minion-killed
      // structures have no killer, so the owner is the only signal.
      if (killer) return killer.teamId;
      return ev.teamId === 100 ? 200 : ev.teamId === 200 ? 100 : null;
    }
    return ev.killerTeamId || killer?.teamId || null;
  };

  const takes = events
    .filter((ev) => ev.type === 'ELITE_MONSTER_KILL' || ev.type === 'BUILDING_KILL')
    .map((ev) => ({ teamId: teamOfTake(ev), side: objectiveSide(ev), value: objectiveValue(ev), t: ev.timestamp }))
    .filter((t) => (t.teamId === 100 || t.teamId === 200) && t.side)
    .sort((a, b) => a.t - b.t);

  // Each objective can belong to at most one trade, paired with the nearest
  // eligible counter in time. Without that, one drake taken during a flurry of
  // turret trades counts against every one of them.
  const traded = { 100: { won: 0, lost: 0, count: 0 }, 200: { won: 0, lost: 0, count: 0 } };
  const paired = new Set();
  for (let i = 0; i < takes.length; i++) {
    if (paired.has(i)) continue;
    const a = takes[i];
    let best = -1;
    for (let k = 0; k < takes.length; k++) {
      if (k === i || paired.has(k)) continue;
      const b = takes[k];
      if (b.teamId === a.teamId || b.side === a.side) continue;
      if (Math.abs(b.t - a.t) > TRADE_WINDOW_MS) continue;
      if (best === -1 || Math.abs(b.t - a.t) < Math.abs(takes[best].t - a.t)) best = k;
    }
    if (best === -1) continue;
    const b = takes[best];
    paired.add(i);
    paired.add(best);
    traded[a.teamId].won += a.value;
    traded[a.teamId].lost += b.value;
    traded[a.teamId].count += 1;
    traded[b.teamId].won += b.value;
    traded[b.teamId].lost += a.value;
    traded[b.teamId].count += 1;
  }
  for (const p of players) {
    p.tradeValueWon = traded[p.teamId].won;
    p.tradeValueLost = traded[p.teamId].lost;
    p.tradeCount = traded[p.teamId].count;
  }

  // --- late-game kill participation ----------------------------------------
  // "Were you in the fights that decided the game" — the laning-phase KP a
  // snowballing lane racks up shouldn't paper over vanishing after 15 minutes.
  const lateKills = kills.filter((k) => k.timestamp >= LANE_PHASE_MS);
  for (const ev of lateKills) {
    const killerTeam = ev.victimTeamId === 100 ? 200 : 100;
    teams[killerTeam].lateKills += 1;
  }
  const lateCredits = new Map(players.map((p) => [p.participantId, 0]));
  for (const ev of lateKills) {
    for (const id of [ev.killerId, ...(ev.assistingParticipantIds || [])]) {
      if (lateCredits.has(id)) lateCredits.set(id, lateCredits.get(id) + 1);
    }
  }
  for (const p of players) {
    const teamLate = teams[p.teamId].lateKills;
    p.lateKp = teamLate >= 4 ? clamp(lateCredits.get(p.participantId) / teamLate, 0, 1) : null;
  }

  // --- plates from timeline (challenges field is missing on older matches) ---
  const plateCounts = new Map(players.map((p) => [p.participantId, 0]));
  for (const ev of events) {
    if (ev.type !== 'TURRET_PLATE_DESTROYED') continue;
    if (plateCounts.has(ev.killerId)) plateCounts.set(ev.killerId, plateCounts.get(ev.killerId) + 1);
  }
  for (const p of players) {
    p.platesTaken = Math.max(p.platesTaken || 0, plateCounts.get(p.participantId) || 0);
  }

  return ctx;
}
