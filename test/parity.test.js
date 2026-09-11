// The bot decides who sits out by comparing composites across roles. That only
// means anything if the five rubrics agree on what an average game is worth —
// otherwise the bench is decided by which role you were assigned.
//
// This is the guard on every future weight change: reweight a rubric and if it
// drifts off the others, this fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch } from '../src/scoring/index.js';
import { BASELINE } from '../src/scoring/roles.js';

const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

// "Dead even" has to mean "every player is at the bar their role is measured
// against" — so the fixture is derived from the live baselines rather than from
// a hardcoded table.
//
// Hardcoding it was fine while the baselines were hand-set guesses, because the
// two were written together. The moment the bars became measured, a fixed table
// stopped describing an average game and this test started asserting that a
// below-median player scores 50. Deriving it keeps the test meaningful across
// every future recalibration.
const B = BASELINE;
const perMin = (role, key, fallback) => (B[role][key] != null ? B[role][key] : fallback);
const RATE = Object.fromEntries(
  ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'].map((role) => [
    role,
    {
      dmg: B[role].dmgShare,
      taken: B[role].tankShare,
      // Jungle's farm is monsters; everyone else's is lane minions. The split is
      // not in BASELINE, so it stays a property of the fixture.
      cs: role === 'JUNGLE' ? 1.2 : B[role].csPerMin,
      jg: role === 'JUNGLE' ? B[role].csPerMin - 1.2 : 0.3,
      gold: B[role].goldPerMin,
      gold14: B[role].gold14,
      xp14: B[role].xp14,
      vis: B[role].visionPerMin,
      td: perMin(role, 'turretDmgPerMin', 100),
      // Support's CC and heal bars are p90, not medians: they grade whichever
      // axis the champion specialises in. A median support sits below both.
      cc: role === 'UTILITY' ? B.UTILITY.ccScore / 30 : 1.0,
      hs: role === 'UTILITY' ? B.UTILITY.healShield : 0,
      kp: B[role].kp
    }
  ])
);
const TEAM_DPM = 2600;

// Deaths are graded on a *weighted* rate, so the fixture cannot just pick a
// number: it has to die often enough that the weighted figure lands on the bar.
// Each death below is given two attackers (weight 1.0) and spread evenly through
// the game, where the late-game multiplier averages about 1.22.
// Three attackers per death: enough credit slots to give all five killers their
// measured post-15 participation rate, and a known death weight (0.75).
const ATTACKERS_PER_DEATH = 3;
const DEATH_WEIGHT = 0.75;
const LATE_DEATH_MULTIPLIER = 1.22;
const deathsFor = (role, minutes) =>
  Math.max(1, Math.round((B[role].wDeathsPerMin * minutes) / (DEATH_WEIGHT * LATE_DEATH_MULTIPLIER)));

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

/** `oppTweak(role)` overrides the ENEMY player in that role, leaving ours alone. */
function evenGame(minutes, oppTweak = () => ({})) {
  const participants = [];
  for (let id = 1; id <= 10; id++) {
    const role = ROLES[(id - 1) % 5];
    const r = { ...RATE[role], ...(id > 5 ? oppTweak(role) : {}) };
    participants.push({
      puuid: `p${id}`, participantId: id, teamId: id <= 5 ? 100 : 200,
      teamPosition: role, championName: role, win: id > 5,
      kills: Math.round(minutes * 0.18), deaths: deathsFor(role, minutes), assists: Math.round(minutes * 0.32),
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
      const role = ROLES[(id - 1) % 5];
      const r = { ...RATE[role], ...(id > 5 ? oppTweak(role) : {}) };
      // Laning gold and xp are now graded against their own measured bars, not
      // inferred from the whole-game rate — a top laner on the median gold/min
      // is 15% *above* the median gold@14, because the two are different
      // distributions. So the frames have to land exactly on gold14/xp14 at the
      // bench minute, then carry on at the game rate.
      const lane = Math.min(m, 14) / 14;
      const after = Math.max(0, m - 14);
      pfs[String(id)] = {
        participantId: id,
        totalGold: Math.round(r.gold14 * lane + r.gold * after),
        xp: Math.round(r.xp14 * lane + r.gold * 1.15 * after),
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
  // Deaths spread evenly through the game, and credited so that each killer's
  // post-15 participation lands on their role's bar.
  //
  // Both halves matter. The death count sets the weighted death rate; who is
  // credited on each kill sets `lateKp`, which is derived from the timeline and
  // cannot be set directly the way `killParticipation` can. Leaving the credit
  // structure arbitrary gave one role 100% post-15 participation and the rest
  // 21%, which is not a dead-even game by any reading.
  const lateBar = (role) => B[role].lateKp;
  for (const victimTeam of [100, 200]) {
    const victims = victimTeam === 100 ? [1, 2, 3, 4, 5] : [6, 7, 8, 9, 10];
    const killers = victimTeam === 100 ? [6, 7, 8, 9, 10] : [1, 2, 3, 4, 5];

    // Every kill on this side, in time order.
    const events = [];
    for (const id of victims) {
      const n = deathsFor(ROLES[(id - 1) % 5], minutes);
      for (let i = 0; i < n; i++) events.push({ id, m: Math.round(((i + 0.5) / n) * minutes) });
    }
    events.sort((a, b) => a.m - b.m);

    // Each killer needs credit in `bar × lateKills` of the post-15 kills. The
    // five bars sum to about 2.6, so two attackers per kill cannot carry the
    // credit — three can, and three attackers is a known death weight (0.75).
    const lateCount = events.filter((e) => e.m >= 15).length;
    const owed = new Map(killers.map((k) => [k, lateBar(ROLES[(k - 1) % 5]) * lateCount]));

    // The jungler is excluded from pre-15 kills. Crediting them there registers
    // as a gank, which lowers the victim's lane bar — so a fixture meant to be
    // dead even would hand every laner a lane they "beat".
    const jungler = killers.find((k) => ROLES[(k - 1) % 5] === 'JUNGLE');
    for (const e of events) {
      const eligible = e.m >= 15 ? killers : killers.filter((k) => k !== jungler);
      // Whoever is furthest behind their quota gets credited, so every killer
      // converges on their own rate rather than one of them taking everything.
      const credited = [...eligible].sort((a, b) => (owed.get(b) ?? 0) - (owed.get(a) ?? 0)).slice(0, ATTACKERS_PER_DEATH);
      if (e.m >= 15) for (const k of credited) owed.set(k, (owed.get(k) ?? 0) - 1);
      ev(e.m, {
        type: 'CHAMPION_KILL',
        killerId: credited[0],
        victimId: e.id,
        assistingParticipantIds: credited.slice(1),
        position: POS[e.id]
      });
    }
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

// A component that can be maxed in champion select is not measuring play. This
// is the guard: hold a player's own stats fixed and vary only the opponent
// across the range one role realistically spans on champion identity alone.
const CHAMPION_SPREAD = {
  TOP: { cs: [4.5, 8.0], dmg: [0.14, 0.28], td: [60, 400], cc: [0.5, 5.0], hs: [0, 60] },
  JUNGLE: { cs: [4.0, 7.5], dmg: [0.12, 0.26], td: [20, 200], cc: [0.5, 5.0], hs: [0, 40] },
  MIDDLE: { cs: [5.5, 9.0], dmg: [0.18, 0.36], td: [40, 200], cc: [0.4, 3.5], hs: [0, 40] },
  BOTTOM: { cs: [5.5, 10.7], dmg: [0.2, 0.38], td: [120, 450], cc: [0.2, 2.0], hs: [0, 40] },
  UTILITY: { cs: [0.5, 2.5], dmg: [0.04, 0.16], td: [5, 60], cc: [1.0, 12.0], hs: [0, 1200] }
};

/** Same lobby, but the enemy in `role` is swapped for a weak or strong pick. */
function versusChampion(role, end) {
  const i = end === 'weak' ? 0 : 1;
  const s = CHAMPION_SPREAD[role];
  const scored = evenGame(41, (r) =>
    r === role ? { dmg: s.dmg[i], cs: s.cs[i], td: s.td[i], cc: s.cc[i], hs: s.hs[i] } : {}
  );
  return scored[`p${ROLES.indexOf(role) + 1}`].composite;
}

test('no role’s score is decided by who the enemy picked', () => {
  const swings = ROLES.map((role) => [role, versusChampion(role, 'weak') - versusChampion(role, 'strong')]);
  for (const [role, swing] of swings) {
    assert.ok(swing > 0, `${role} should still reward beating your counterpart`);
    assert.ok(swing < 9, `${role} swings ${swing.toFixed(1)} points on champion select alone`);
  }
  // And the roles must be comparable in how matchup-dependent they are. Support
  // was 5.6x mid, almost entirely from Utility being graded head-to-head only:
  // a Soraka opposite an Ashe support scored ~100 on 22% of the grade.
  const worst = Math.max(...swings.map(([, s]) => s));
  const best = Math.min(...swings.map(([, s]) => s));
  assert.ok(worst / best < 3, `matchup dependence ranges ${best.toFixed(1)}–${worst.toFixed(1)} across roles`);
});
