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

  const traded = tradeWindowKills.some(
    (k) => k.victimTeamId !== victimTeamId && Math.abs(k.timestamp - ev.timestamp) <= 12000
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
      laneVisitsGiven: 0, // jungle: lane visits this player made
      weightedDeathsPerMin: null,
      deathTags: null,
      lateKp: null,
      epicCredits: 0,
      epicShare: null,
      teamEpicWeighted: null,
      teamEpicControl: null,
      teamLaneGold14: null,
      alliesUnanswered: null,
      dataQuality: hasTimeline ? 'full' : 'partial'
    };
  });

  const byId = new Map(players.map((p) => [p.participantId, p]));
  const byPuuid = new Map(players.map((p) => [p.puuid, p]));

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
  }

  // Bot lane is a 2v2, so the pair's combined economy is the honest read on who
  // won it — a support who gave up every trade can't hide behind their ADC's CS.
  for (const teamId of [100, 200]) {
    const pair = players.filter((p) => p.teamId === teamId && (p.role === 'BOTTOM' || p.role === 'UTILITY'));
    const other = players.filter((p) => p.teamId !== teamId && (p.role === 'BOTTOM' || p.role === 'UTILITY'));
    if (pair.length === 2 && other.length === 2) {
      const diff = pair.reduce((s, p) => s + (p.gold14 || 0), 0) - other.reduce((s, p) => s + (p.gold14 || 0), 0);
      pair.forEach((p) => (p.pairGoldDiff14 = diff));
    }
  }

  // Team lane economy at 14 — the jungler's report card. Junglers are excluded:
  // this measures the state of the map the jungler was responsible for shaping.
  for (const teamId of [100, 200]) {
    teams[teamId].laneGold14 = players
      .filter((p) => p.teamId === teamId && p.role !== 'JUNGLE')
      .reduce((s, p) => s + (p.gold14 || 0), 0);
  }
  for (const p of players) {
    p.teamLaneGold14 = teams[p.teamId].laneGold14 - teams[p.teamId === 100 ? 200 : 100].laneGold14;
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

  // The mirror signal: takedowns a laner got *with* their own jungler in lane.
  // Being handed two free kills by your jungler and still ending laning even is
  // a worse result than going even with no help at all.
  const helpReceived = new Map(players.map((p) => [p.participantId, 0]));
  for (const ev of kills) {
    if (ev.timestamp >= LANE_PHASE_MS) continue;
    const victim = byId.get(ev.victimId);
    if (!victim) continue;
    const allyJungler = junglers[victim.teamId === 100 ? 200 : 100];
    if (!allyJungler) continue;
    const participants = [ev.killerId, ...(ev.assistingParticipantIds || [])];
    if (!participants.includes(allyJungler.participantId)) continue;
    for (const id of participants) {
      const helper = byId.get(id);
      if (!helper || helper.role === 'JUNGLE' || helper.role === 'UNKNOWN') continue;
      helpReceived.set(id, helpReceived.get(id) + 1);
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

  for (const p of players) {
    if (!zoneForRole(p.role)) continue; // junglers don't receive lane pressure
    const v = visitCount.get(p.participantId);
    // A landed gank is hard evidence. Frame snapshots are 60s apart so they miss
    // most ganks entirely and over-count a jungler who parks in a lane — worth
    // less each, and capped.
    p.pressureAgainst = p.gankDeaths + Math.min(v.against, 4) * 0.6;
    p.pressureFor = helpReceived.get(p.participantId) + Math.min(v.for, 4) * 0.6;
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
