// The bot decides who sits out by comparing composites across roles. That only
// means anything if the five rubrics agree on what an average game is worth —
// otherwise the bench is decided by which role you were assigned.
//
// This is the guard on every future weight change: reweight a rubric and if it
// drifts off the others, this fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch } from '../src/scoring/index.js';

const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

// Per-minute output for an unremarkable game in each role, mirrored across both
// teams so every lane is dead level and nobody did anything notable.
const RATE = {
  TOP: { dmg: 0.21, taken: 0.27, cs: 6.4, jg: 0.6, gold: 400, vis: 0.55, td: 180, cc: 2.4, hs: 0, kp: 0.5 },
  JUNGLE: { dmg: 0.18, taken: 0.21, cs: 1.2, jg: 4.4, gold: 400, vis: 0.9, td: 60, cc: 2.0, hs: 0, kp: 0.62 },
  MIDDLE: { dmg: 0.26, taken: 0.17, cs: 7.0, jg: 0.3, gold: 430, vis: 0.65, td: 110, cc: 1.2, hs: 0, kp: 0.58 },
  BOTTOM: { dmg: 0.28, taken: 0.15, cs: 7.6, jg: 0.3, gold: 450, vis: 0.55, td: 260, cc: 0.6, hs: 0, kp: 0.56 },
  UTILITY: { dmg: 0.09, taken: 0.2, cs: 1.2, jg: 0, gold: 260, vis: 1.9, td: 20, cc: 5.5, hs: 300, kp: 0.62 }
};
const TEAM_DPM = 2600;

// Each laner in their own lane, in contest range of their counterpart, on their
// own side of the diagonal; both junglers in open jungle out of gank range of
// everyone, so neither side registers pressure given or taken.
const POS = {
  1: { x: 1200, y: 12800 }, 6: { x: 2200, y: 13800 },
  2: { x: 4500, y: 9500 }, 7: { x: 10500, y: 5500 },
  3: { x: 6800, y: 7200 }, 8: { x: 7800, y: 8200 },
  4: { x: 12800, y: 1200 }, 9: { x: 13800, y: 2200 },
  5: { x: 12500, y: 1300 }, 10: { x: 13500, y: 2300 }
};

function evenGame(minutes) {
  const participants = [];
  for (let id = 1; id <= 10; id++) {
    const role = ROLES[(id - 1) % 5];
    const r = RATE[role];
    participants.push({
      puuid: `p${id}`, participantId: id, teamId: id <= 5 ? 100 : 200,
      teamPosition: role, championName: role, win: id > 5,
      kills: Math.round(minutes * 0.18), deaths: Math.round(minutes * 0.17), assists: Math.round(minutes * 0.32),
      totalDamageDealtToChampions: Math.round(TEAM_DPM * r.dmg * minutes),
      goldEarned: Math.round(r.gold * minutes),
      totalMinionsKilled: Math.round(r.cs * minutes), neutralMinionsKilled: Math.round(r.jg * minutes),
      visionScore: Math.round(r.vis * minutes), wardsPlaced: Math.round(minutes),
      wardsKilled: Math.round(minutes * 0.16), detectorWardsPlaced: Math.round(minutes * 0.12),
      damageDealtToTurrets: Math.round(r.td * minutes), turretTakedowns: 1, objectivesStolen: 0,
      timeCCingOthers: Math.round(r.cc * minutes),
      totalHealsOnTeammates: Math.round(r.hs * minutes), totalDamageShieldedOnTeammates: 0,
      challenges: {
        killParticipation: r.kp, teamDamagePercentage: r.dmg, damageTakenOnTeamPercentage: r.taken,
        damagePerMinute: TEAM_DPM * r.dmg, visionScorePerMinute: r.vis,
        controlWardsPlaced: Math.round(minutes * 0.12), wardTakedowns: Math.round(minutes * 0.16),
        turretPlatesTaken: 1, soloKills: 0, enemyJungleMonsterKills: role === 'JUNGLE' ? 6 : 0,
        effectiveHealAndShielding: Math.round(r.hs * minutes),
        enemyChampionImmobilizations: Math.round(r.cc / 4), saveAllyFromDeath: 0
      }
    });
  }

  const frames = [];
  for (let m = 0; m <= Math.floor(minutes); m++) {
    const pfs = {};
    for (let id = 1; id <= 10; id++) {
      const r = RATE[ROLES[(id - 1) % 5]];
      pfs[String(id)] = {
        participantId: id, totalGold: Math.round(r.gold * m), xp: Math.round(r.gold * 1.15 * m),
        minionsKilled: Math.round(r.cs * m), jungleMinionsKilled: Math.round(r.jg * m), position: POS[id]
      };
    }
    frames.push({ timestamp: m * 60000, participantFrames: pfs, events: [] });
  }
  const ev = (m, e) => { if (m < frames.length) frames[m].events.push({ timestamp: m * 60000 + 1, ...e }); };
  // Two objectives each, and one even cross-map trade.
  ev(9, { type: 'ELITE_MONSTER_KILL', killerId: 2, killerTeamId: 100, monsterType: 'DRAGON', monsterSubType: 'FIRE_DRAGON', assistingParticipantIds: [3, 4] });
  ev(11, { type: 'ELITE_MONSTER_KILL', killerId: 7, killerTeamId: 200, monsterType: 'DRAGON', monsterSubType: 'EARTH_DRAGON', assistingParticipantIds: [8, 9] });
  ev(15, { type: 'ELITE_MONSTER_KILL', killerId: 6, killerTeamId: 200, monsterType: 'RIFTHERALD', assistingParticipantIds: [7] });
  ev(18, { type: 'ELITE_MONSTER_KILL', killerId: 2, killerTeamId: 100, monsterType: 'DRAGON', monsterSubType: 'AIR_DRAGON', assistingParticipantIds: [1, 5] });
  for (let id = 1; id <= 10; id++) {
    const killer = id <= 5 ? id + 5 : id - 5;
    const mates = (id <= 5 ? [6, 7, 8, 9, 10] : [1, 2, 3, 4, 5]).filter((x) => x !== killer).slice(0, 2);
    [6, 13, 19, 25, 31].slice(0, Math.round(minutes * 0.17)).forEach((m) =>
      ev(m, { type: 'CHAMPION_KILL', killerId: killer, victimId: id, assistingParticipantIds: mates, position: POS[id] }));
  }

  return scoreMatch(
    { metadata: { matchId: 'EVEN' }, info: { gameDuration: Math.round(minutes * 60), gameEndTimestamp: Date.now(), mapId: 11, queueId: 420, participants } },
    { timeline: { info: { frameInterval: 60000, frames, participants: participants.map((p) => ({ participantId: p.participantId, puuid: p.puuid })) } }, trackedPuuids: [] }
  );
}

test('a dead-even game scores every role near 50', () => {
  const scored = evenGame(30);
  for (let id = 1; id <= 5; id++) {
    const c = scored[`p${id}`].composite;
    assert.ok(c > 44 && c < 56, `${ROLES[id - 1]} scored ${c} in a game where nobody did anything`);
  }
});

test('no role is structurally advantaged over another', () => {
  // A gap here is a gap in who gets benched, for reasons that have nothing to
  // do with how anyone played.
  const scored = evenGame(30);
  const composites = [1, 2, 3, 4, 5].map((id) => scored[`p${id}`].composite);
  const spread = Math.max(...composites) - Math.min(...composites);
  assert.ok(spread < 5, `roles spread ${spread.toFixed(1)} points apart in an even game`);
});

test('and it holds at every game length, not just a typical one', () => {
  for (const minutes of [20, 26, 33, 40]) {
    const scored = evenGame(minutes);
    const composites = [1, 2, 3, 4, 5].map((id) => scored[`p${id}`].composite);
    const spread = Math.max(...composites) - Math.min(...composites);
    assert.ok(spread < 6, `${minutes}min: roles spread ${spread.toFixed(1)} points apart`);
  }
});

test('every rubric sums to 100 at the reference game length', () => {
  // Lane weight scales with how long the game ran, so 27 minutes — the
  // reference the scaling is anchored on — is the one length where every
  // declared weight is at its face value. Away from it the totals drift and
  // that is fine: weightedMean renormalises, and it has to anyway, because
  // components with no timeline data drop out rather than scoring zero.
  const scored = evenGame(27);
  for (let id = 1; id <= 5; id++) {
    const total = scored[`p${id}`].components.reduce((s, c) => s + c.weight, 0);
    assert.equal(total, 100, `${ROLES[id - 1]} weights sum to ${total}`);
  }
});
