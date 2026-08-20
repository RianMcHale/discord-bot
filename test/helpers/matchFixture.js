// Synthetic Summoner's Rift matches for testing the scoring model.
//
// The default scenario is the one the role-based rewrite exists to get right:
// a jungler who farms safely to 3/2/9 while contesting nothing and letting every
// lane fall behind, and a top laner camped three times by the enemy jungler.
// Under a lobby-wide composite the jungler scores well and the top laner scores
// last. Both are wrong, and the tests assert they no longer happen.

export const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

const DEFAULT_LINE = {
  1: { n: 'TopCamped', k: 1, d: 7, a: 2, dmg: 14000, gold: 11000, cs: 190, jg: 0, vis: 22, cw: 3, wk: 4, td: 1200, cc: 40, hs: 0 },
  2: { n: 'JgFarmer', k: 3, d: 2, a: 9, dmg: 13000, gold: 12500, cs: 210, jg: 175, vis: 26, cw: 4, wk: 5, td: 900, cc: 30, hs: 0 },
  3: { n: 'Mid', k: 6, d: 5, a: 6, dmg: 24000, gold: 13500, cs: 235, jg: 10, vis: 20, cw: 3, wk: 3, td: 1800, cc: 25, hs: 0 },
  4: { n: 'Adc', k: 8, d: 4, a: 5, dmg: 27000, gold: 14200, cs: 265, jg: 12, vis: 18, cw: 2, wk: 2, td: 5200, cc: 10, hs: 0 },
  5: { n: 'Sup', k: 1, d: 8, a: 14, dmg: 6000, gold: 8200, cs: 35, jg: 0, vis: 62, cw: 12, wk: 14, td: 200, cc: 180, hs: 9000 },
  6: { n: 'EnemyTop', k: 7, d: 2, a: 5, dmg: 21000, gold: 14500, cs: 225, jg: 5, vis: 25, cw: 4, wk: 5, td: 6400, cc: 90, hs: 0 },
  7: { n: 'EnemyJg', k: 6, d: 3, a: 13, dmg: 17000, gold: 13800, cs: 200, jg: 160, vis: 40, cw: 9, wk: 11, td: 1500, cc: 70, hs: 0 },
  8: { n: 'EnemyMid', k: 8, d: 3, a: 9, dmg: 29000, gold: 14800, cs: 250, jg: 8, vis: 24, cw: 4, wk: 4, td: 2600, cc: 30, hs: 0 },
  9: { n: 'EnemyAdc', k: 9, d: 3, a: 7, dmg: 31000, gold: 15400, cs: 280, jg: 10, vis: 20, cw: 3, wk: 3, td: 7800, cc: 15, hs: 0 },
  10: { n: 'EnemySup', k: 2, d: 5, a: 20, dmg: 7000, gold: 8900, cs: 40, jg: 0, vis: 70, cw: 14, wk: 16, td: 300, cc: 210, hs: 11000 }
};

const teamOf = (id) => (id <= 5 ? 100 : 200);

function buildParticipants(line, durationSeconds, { roleFor = (id) => ROLES[(id - 1) % 5] } = {}) {
  const mins = durationSeconds / 60;
  const sum = (team, key) =>
    Object.entries(line)
      .filter(([id]) => teamOf(Number(id)) === team)
      .reduce((s, [, v]) => s + v[key], 0);

  return Object.entries(line).map(([idStr, v]) => {
    const id = Number(idStr);
    const teamId = teamOf(id);
    return {
      puuid: `p${id}`,
      participantId: id,
      teamId,
      teamPosition: roleFor(id),
      championName: v.n,
      win: teamId === 200,
      kills: v.k,
      deaths: v.d,
      assists: v.a,
      totalDamageDealtToChampions: v.dmg,
      goldEarned: v.gold,
      totalMinionsKilled: v.cs,
      neutralMinionsKilled: v.jg,
      visionScore: v.vis,
      wardsPlaced: v.cw + 14,
      wardsKilled: v.wk,
      detectorWardsPlaced: v.cw,
      damageDealtToTurrets: v.td,
      turretTakedowns: 0,
      objectivesStolen: 0,
      timeCCingOthers: v.cc,
      totalHealsOnTeammates: v.hs,
      totalDamageShieldedOnTeammates: 0,
      challenges: {
        killParticipation: (v.k + v.a) / Math.max(sum(teamId, 'k'), 1),
        teamDamagePercentage: v.dmg / sum(teamId, 'dmg'),
        damageTakenOnTeamPercentage: 0.2,
        damagePerMinute: v.dmg / mins,
        visionScorePerMinute: v.vis / mins,
        controlWardsPlaced: v.cw,
        wardTakedowns: v.wk,
        turretPlatesTaken: id === 6 ? 4 : id === 1 ? 0 : 1,
        soloKills: id === 6 ? 3 : 0,
        enemyJungleMonsterKills: id === 7 ? 22 : id === 2 ? 4 : 0,
        effectiveHealAndShielding: v.hs,
        enemyChampionImmobilizations: Math.round(v.cc / 4),
        saveAllyFromDeath: id === 10 ? 2 : 0
      }
    };
  });
}

// Lane positions on the standard 15000x15000 map.
const POS = {
  1: { x: 1600, y: 9500 }, 6: { x: 2200, y: 10800 },
  3: { x: 7000, y: 6800 }, 8: { x: 7800, y: 7600 },
  4: { x: 10000, y: 2000 }, 9: { x: 11000, y: 2600 },
  5: { x: 10200, y: 2300 }, 10: { x: 11200, y: 2900 },
  2: { x: 8000, y: 3500 }, // ally jungler: farming bot side, never in a lane
  7: { x: 2400, y: 9800 } // enemy jungler: parked on top lane
};
const GOLD14 = { 1: 4200, 2: 5600, 3: 5000, 4: 5400, 5: 3400, 6: 5800, 7: 5400, 8: 5600, 9: 5900, 10: 3700 };
const XP14 = { 1: 5200, 2: 7000, 3: 6600, 4: 6300, 5: 4200, 6: 7000, 7: 6900, 8: 7000, 9: 6800, 10: 4500 };

function buildTimeline(line, durationMinutes) {
  const frames = [];
  for (let m = 0; m <= durationMinutes; m++) {
    const participantFrames = {};
    for (const idStr of Object.keys(line)) {
      const i = Number(idStr);
      // The enemy jungler only sits in top lane between minutes 4 and 11.
      const pos = i === 7 && (m < 4 || m > 11) ? { x: 9000, y: 8000 } : POS[i];
      participantFrames[idStr] = {
        participantId: i,
        totalGold: Math.round((GOLD14[i] / 14) * Math.max(m, 1)),
        xp: Math.round((XP14[i] / 14) * Math.max(m, 1)),
        minionsKilled: Math.round((line[i].cs / durationMinutes) * m),
        jungleMinionsKilled: Math.round((line[i].jg / durationMinutes) * m),
        position: pos
      };
    }
    frames.push({ timestamp: m * 60000, participantFrames, events: [] });
  }

  // Events are written at fixed minutes, so a shorter game simply doesn't have
  // the later ones rather than indexing past the end of the frame list.
  const ev = (m, e) => {
    if (m >= frames.length) return;
    frames[m].events.push({ timestamp: m * 60000 + 1, ...e });
  };

  // Three ganks on top by the enemy jungler.
  [5, 8, 11].forEach((m) =>
    ev(m, { type: 'CHAMPION_KILL', killerId: 6, victimId: 1, assistingParticipantIds: [7], position: POS[1] })
  );
  ev(19, { type: 'CHAMPION_KILL', killerId: 6, victimId: 1, assistingParticipantIds: [], position: POS[6] });
  [24, 28].forEach((m) =>
    ev(m, { type: 'CHAMPION_KILL', killerId: 9, victimId: 1, assistingParticipantIds: [7, 8, 10], position: { x: 9000, y: 9000 } })
  );
  ev(30, { type: 'CHAMPION_KILL', killerId: 8, victimId: 1, assistingParticipantIds: [9], position: { x: 9000, y: 9000 } });

  // The jungler's two deaths, both in teamfights.
  [22, 27].forEach((m) =>
    ev(m, { type: 'CHAMPION_KILL', killerId: 8, victimId: 2, assistingParticipantIds: [6, 9, 10], position: { x: 8000, y: 8000 } })
  );

  // Scattered other deaths so the lobby isn't degenerate.
  const others = { 3: [9, 16, 20, 26, 29], 4: [12, 18, 25, 31], 5: [7, 10, 14, 17, 21, 23, 26, 30], 6: [15, 23], 7: [13, 20, 28], 8: [11, 19, 27], 9: [14, 22, 29], 10: [8, 16, 21, 25, 30] };
  for (const [victim, minutes] of Object.entries(others)) {
    const killers = Number(victim) <= 5 ? [6, 8, 9] : [3, 4, 1];
    minutes
      .filter((m) => m <= durationMinutes)
      .forEach((m) =>
        ev(m, { type: 'CHAMPION_KILL', killerId: killers[0], victimId: Number(victim), assistingParticipantIds: killers.slice(1), position: { x: 7500, y: 7500 } })
      );
  }

  // Team 200 takes almost every objective.
  ev(9, { type: 'ELITE_MONSTER_KILL', killerId: 7, killerTeamId: 200, monsterType: 'DRAGON', monsterSubType: 'FIRE_DRAGON', assistingParticipantIds: [9, 10] });
  ev(16, { type: 'ELITE_MONSTER_KILL', killerId: 7, killerTeamId: 200, monsterType: 'DRAGON', monsterSubType: 'EARTH_DRAGON', assistingParticipantIds: [8, 9] });
  ev(24, { type: 'ELITE_MONSTER_KILL', killerId: 7, killerTeamId: 200, monsterType: 'DRAGON', monsterSubType: 'AIR_DRAGON', assistingParticipantIds: [6, 8, 9, 10] });
  ev(12, { type: 'ELITE_MONSTER_KILL', killerId: 6, killerTeamId: 200, monsterType: 'RIFTHERALD', assistingParticipantIds: [7] });
  ev(27, { type: 'ELITE_MONSTER_KILL', killerId: 7, killerTeamId: 200, monsterType: 'BARON_NASHOR', assistingParticipantIds: [6, 8, 9, 10] });
  ev(20, { type: 'ELITE_MONSTER_KILL', killerId: 2, killerTeamId: 100, monsterType: 'DRAGON', monsterSubType: 'WATER_DRAGON', assistingParticipantIds: [3, 4] });
  [3, 4, 5, 6].forEach((m) => ev(m, { type: 'TURRET_PLATE_DESTROYED', killerId: 6, laneType: 'TOP_LANE' }));

  return frames;
}

/** The camped-top / farming-jungler scenario, with a full timeline. */
export function campedTopScenario({ durationMinutes = 32 } = {}) {
  const durationSeconds = durationMinutes * 60;
  const participants = buildParticipants(DEFAULT_LINE, durationSeconds);
  const frames = buildTimeline(DEFAULT_LINE, durationMinutes);

  return {
    match: {
      metadata: { matchId: 'TEST_CAMPED' },
      info: { gameDuration: durationSeconds, gameEndTimestamp: Date.now(), mapId: 11, queueId: 420, participants }
    },
    timeline: {
      info: {
        frameInterval: 60000,
        frames,
        participants: participants.map((p) => ({ participantId: p.participantId, puuid: p.puuid }))
      }
    },
    // Named handles so tests read as intentions rather than participant numbers.
    puuids: { campedTop: 'p1', farmingJungler: 'p2', mid: 'p3', adc: 'p4', support: 'p5', enemyJungler: 'p7' }
  };
}

/** A plain 10-player match with no timeline, for edge cases. */
export function plainMatch({ durationSeconds = 1800, mapId = 11, queueId = 420, roleFor, info = {} } = {}) {
  const participants = buildParticipants(DEFAULT_LINE, durationSeconds, roleFor ? { roleFor } : {});
  return {
    metadata: { matchId: 'TEST_PLAIN' },
    info: { gameDuration: durationSeconds, gameEndTimestamp: Date.now(), mapId, queueId, participants, ...info }
  };
}
