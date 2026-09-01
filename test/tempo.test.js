// "Lanes @14" graded a jungler almost entirely on four other people's gold, and
// symmetrically with the enemy jungler, so a laner running it down handed the
// other jungler credit for it. Tempo & map control replaces it with three
// things the jungler actually decides.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch } from '../src/scoring/index.js';
import { campedTopScenario } from './helpers/matchFixture.js';

const JG = 2;
const TOP_LANE = { x: 1600, y: 9500 };
const OWN_JUNGLE = { x: 8000, y: 3500 };
const EVEN = { 1: 5000, 2: 5600, 3: 5000, 4: 5400, 5: 3400, 6: 5000, 7: 5600, 8: 5000, 9: 5400, 10: 3400 };

/**
 * A level lobby with one lane moved and the jungler parked somewhere.
 *
 * @param where  'top' parks our jungler in top lane for laning phase; 'home'
 *               leaves them on their own camps.
 * @param topAhead  gold our top laner is up at 14; other lanes stay level.
 * @param trades  ELITE_MONSTER_KILL events replacing the fixture's own.
 */
function game({ where = 'home', topAhead = 0, counterCamps = 4, trades = null, postSwing = 0 } = {}) {
  const s = campedTopScenario({ durationMinutes: 32 });

  s.timeline.info.frames.forEach((f, m) => {
    for (const id of Object.keys(EVEN)) {
      const base = EVEN[id] + (Number(id) === 1 ? topAhead : 0);
      f.participantFrames[id].totalGold = Math.round((base / 14) * Math.max(Math.min(m, 14), 1));
      if (Number(id) === JG && m <= 15) {
        f.participantFrames[id].position = where === 'top' ? TOP_LANE : OWN_JUNGLE;
      }
    }
  });
  // End-of-game gold holds the 14-minute gap open, so "nothing changed after
  // laning" is the default and `postSwing` is the only thing that closes it.
  for (const p of s.match.info.participants) {
    p.goldEarned = 17000 + (p.participantId === 6 ? -topAhead : 0);
  }
  s.match.info.participants.find((p) => p.participantId === 1).goldEarned += postSwing;
  s.match.info.participants.find((p) => p.participantId === JG).challenges.enemyJungleMonsterKills = counterCamps;

  if (trades) {
    s.timeline.info.frames.forEach((f) => {
      f.events = f.events.filter((e) => e.type !== 'ELITE_MONSTER_KILL');
    });
    for (const t of trades) {
      s.timeline.info.frames[t.m].events.push({
        timestamp: t.m * 60000 + (t.sec ?? 0) * 1000,
        type: 'ELITE_MONSTER_KILL',
        killerId: t.team === 100 ? JG : 7,
        killerTeamId: t.team,
        monsterType: t.type,
        monsterSubType: t.sub,
        assistingParticipantIds: []
      });
    }
  }

  const scored = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
  return { jungler: scored.p2, tempo: scored.p2.components.find((c) => c.key === 'tempo') };
}

test('the jungle rubric no longer has a flat lane-state component', () => {
  const keys = game().jungler.components.map((c) => c.key);
  assert.ok(!keys.includes('mapstate'), 'Lanes @14 should be gone');
  assert.ok(keys.includes('tempo'));
});

test('lane state is weighted toward the lane the jungler was actually in', () => {
  // Identical lobby, identical top lane result. Only the jungler's pathing moves.
  const camped = game({ where: 'top', topAhead: 2500 });
  const absent = game({ where: 'home', topAhead: 2500 });

  assert.ok(
    camped.tempo.score > absent.tempo.score,
    `camping the lane that won should beat farming through it (${camped.tempo.score} vs ${absent.tempo.score})`
  );
  assert.match(camped.tempo.detail, /mostly top/, 'the detail should say why it was weighted');
  assert.doesNotMatch(absent.tempo.detail, /mostly/);
});

test('a jungler who was nowhere gets the flat average across the three lanes', () => {
  // Presence spread evenly (or absent entirely) has to reproduce the old
  // behaviour exactly, or the change is not a refinement but a different metric.
  const { jungler } = game({ where: 'home', topAhead: 3000 });
  // Top +3000, mid level, bot level, summed over three lane zones.
  assert.equal(jungler.context.weightedLaneGold14, 3000);
});

test('presence cannot make one lane the whole grade', () => {
  // Position is sampled once a minute. It is good enough to say "mostly top",
  // never good enough to blame or absolve a jungler for one lane outright.
  const camped = game({ where: 'top', topAhead: -3000 });
  // A 3k deficit in the camped lane alone, if it were the entire grade, would
  // read as -9000 once rescaled to three lanes. The cap keeps it well short.
  assert.ok(
    camped.jungler.context.weightedLaneGold14 > -6000,
    `one lane must not dominate (${camped.jungler.context.weightedLaneGold14})`
  );
  assert.ok(camped.jungler.context.weightedLaneGold14 < -3000, 'but it must count for more than a flat share');
});

test('cross-map trades are graded on value, not on count', () => {
  const won = game({ trades: [
    { m: 25, sec: 0, team: 100, type: 'BARON_NASHOR' },
    { m: 25, sec: 20, team: 200, type: 'DRAGON', sub: 'FIRE_DRAGON' }
  ] });
  const lost = game({ trades: [
    { m: 25, sec: 0, team: 100, type: 'DRAGON', sub: 'FIRE_DRAGON' },
    { m: 25, sec: 20, team: 200, type: 'BARON_NASHOR' }
  ] });

  assert.ok(won.tempo.score > lost.tempo.score, 'baron for a drake beats drake for a baron');
  assert.match(won.tempo.detail, /traded 1\.5 for 1\.0/);
  assert.match(lost.tempo.detail, /traded 1\.0 for 1\.5/);
});

test('objectives far apart in time are not a trade', () => {
  const apart = game({ trades: [
    { m: 19, sec: 0, team: 100, type: 'BARON_NASHOR' },
    { m: 25, sec: 0, team: 200, type: 'DRAGON', sub: 'FIRE_DRAGON' }
  ] });
  assert.doesNotMatch(apart.tempo.detail, /traded/, 'six minutes apart is two plays, not a trade');
  assert.equal(apart.jungler.context.tradeValueWon, null);
});

test('objectives on the same side of the map are not a trade', () => {
  // Two drakes is a contest for one objective, not a swap of two.
  const sameSide = game({ trades: [
    { m: 25, sec: 0, team: 100, type: 'DRAGON', sub: 'FIRE_DRAGON' },
    { m: 25, sec: 20, team: 200, type: 'DRAGON', sub: 'OCEAN_DRAGON' }
  ] });
  assert.doesNotMatch(sameSide.tempo.detail, /traded/);
});

test('one objective belongs to at most one trade', () => {
  // A drake taken during a flurry of top-side objectives must not be counted
  // against every one of them.
  const flurry = game({ trades: [
    { m: 25, sec: 0, team: 200, type: 'DRAGON', sub: 'FIRE_DRAGON' },
    { m: 25, sec: 10, team: 100, type: 'RIFTHERALD' },
    { m: 25, sec: 20, team: 100, type: 'BARON_NASHOR' }
  ] });
  // Only one pair can form: the drake against whichever top-side take is nearest.
  assert.equal(flurry.jungler.context.tradeValueWon, 1.0, 'herald, paired once');
  assert.equal(flurry.jungler.context.tradeValueLost, 1.0, 'the drake, counted once');
});

// Camps alone read backwards: a jungler who cleared 24 of your camps and died
// five times doing it scored as *winning* the enemy jungle, and the jungler who
// killed them there scored as losing it.
/** Adds `n` kills of `victimId` by `killerId`, deep in the victim's enemy half. */
function invadeKills(s, { killerId, victimId, n, deep = true }) {
  // Team 100's own half is x+y < 15000, so a team-100 victim dying at 12000,12000
  // died on the wrong side of the map.
  const pos = deep
    ? victimId <= 5
      ? { x: 12000, y: 12000 }
      : { x: 2000, y: 2000 }
    : victimId <= 5
      ? { x: 2000, y: 2000 }
      : { x: 12000, y: 12000 };
  for (let i = 0; i < n; i++) {
    const m = 17 + i * 2;
    s.timeline.info.frames[m].events.push({
      timestamp: m * 60000,
      type: 'CHAMPION_KILL',
      killerId,
      victimId,
      assistingParticipantIds: [],
      position: pos
    });
  }
}

test('killing the enemy jungler in their own jungle counts as taking it', () => {
  // Same camp counts both ways. The only difference is who won the fights.
  const base = () => {
    const s = campedTopScenario({ durationMinutes: 32 });
    s.match.info.participants.find((p) => p.participantId === 2).challenges.enemyJungleMonsterKills = 17;
    s.match.info.participants.find((p) => p.participantId === 7).challenges.enemyJungleMonsterKills = 24;
    return s;
  };

  const campsOnly = base();
  const wonTheInvades = base();
  invadeKills(wonTheInvades, { killerId: 2, victimId: 7, n: 5 });

  const scoreOf = (s) =>
    scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] }).p2.components.find((c) => c.key === 'tempo').score;

  assert.ok(
    scoreOf(wonTheInvades) > scoreOf(campsOnly) + 3,
    `killing them there has to beat being out-farmed there (${scoreOf(campsOnly)} -> ${scoreOf(wonTheInvades)})`
  );
});

// The fixture already contains deaths on both sides of the map, so these
// measure the change five invades make rather than absolute counts.
const contextOf = (s, key) => scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] })[key].context;

test('camps bought with your life are not a win', () => {
  const before = campedTopScenario({ durationMinutes: 32 });
  const after = campedTopScenario({ durationMinutes: 32 });
  invadeKills(after, { killerId: 2, victimId: 7, n: 5 });

  // Five takedowns are worth fifteen camps to the winner...
  assert.equal(contextOf(after, 'p2').jungleControl - contextOf(before, 'p2').jungleControl, 15);
  // ...and the same five deaths cost the loser ten off their camp lead.
  assert.equal(contextOf(after, 'p7').jungleControl - contextOf(before, 'p7').jungleControl, -10);
});

test('being collapsed on in a teamfight is not a failed invade', () => {
  // An assassin jungler dies in the enemy half nearly every time, so counting
  // every such death charges a won teamfight at their base as a botched invade.
  const before = campedTopScenario({ durationMinutes: 32 });
  const after = campedTopScenario({ durationMinutes: 32 });
  for (let i = 0; i < 3; i++) {
    const m = 17 + i * 2;
    after.timeline.info.frames[m].events.push({
      timestamp: m * 60000,
      type: 'CHAMPION_KILL',
      killerId: 7,
      victimId: 2,
      assistingParticipantIds: [6, 8, 9, 10], // five of them, i.e. a teamfight
      position: { x: 12000, y: 12000 }
    });
  }
  assert.equal(contextOf(after, 'p2').invadeDeaths, contextOf(before, 'p2').invadeDeaths);
  assert.equal(contextOf(after, 'p2').jungleControl, contextOf(before, 'p2').jungleControl);
});

test('a death in your own jungle is not an invade death', () => {
  const before = campedTopScenario({ durationMinutes: 32 });
  const after = campedTopScenario({ durationMinutes: 32 });
  invadeKills(after, { killerId: 7, victimId: 2, n: 3, deep: false });

  // Dying at home is a death, and the Deaths component charges for it. It is
  // not evidence about who controlled the *enemy* jungle.
  assert.equal(contextOf(after, 'p2').invadeDeaths, contextOf(before, 'p2').invadeDeaths);
  assert.equal(contextOf(after, 'p2').jungleControl, contextOf(before, 'p2').jungleControl);
});

test('the detail line says what went into the invade figure', () => {
  const s = campedTopScenario({ durationMinutes: 32 });
  invadeKills(s, { killerId: 2, victimId: 7, n: 4 });
  const scored = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
  const detail = scored.p2.components.find((c) => c.key === 'tempo').detail;
  assert.match(detail, /4 on their jungler/, 'the camp count alone reads as the whole story otherwise');
  assert.match(scored.p7.components.find((c) => c.key === 'tempo').detail, /\d+ died deep/);
});

test('takedowns on the enemy jungler count after laning phase too', () => {
  // gankTakedowns stops at 15 minutes because a lane gank at 25 is not a gank.
  // A fight over their raptors at 24 minutes is the same event it was at 6.
  const s = campedTopScenario({ durationMinutes: 32 });
  invadeKills(s, { killerId: 2, victimId: 7, n: 3 }); // minutes 17, 19, 21
  const scored = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
  assert.equal(scored.p2.context.enemyJunglerTakedowns, 3);
});

test('counter-jungling moved to tempo and left jungle farm alone', () => {
  const none = game({ counterCamps: 0 });
  const lots = game({ counterCamps: 25 });

  assert.ok(lots.tempo.score > none.tempo.score + 15, 'taking the enemy jungle is a tempo act and should show');
  const farmOf = (g) => g.jungler.components.find((c) => c.key === 'economy').score;
  assert.equal(farmOf(none), farmOf(lots), 'and it must no longer double-count inside Jungle farm');
});

test('the jungler still gets the comeback, measured on the lanes they were in', () => {
  const flat = game({ where: 'top', topAhead: -3000, postSwing: 0 });
  const back = game({ where: 'top', topAhead: -3000, postSwing: 2000 });
  assert.ok(back.tempo.score > flat.tempo.score + 5, 'lanes recovering after 14 has to count');
  assert.match(back.tempo.detail, /post-lane/);
});

test('the jungle weights still sum to 100 and deaths stay the lightest', () => {
  const { jungler } = game();
  const total = jungler.components.reduce((s, c) => s + c.weight, 0);
  assert.equal(total, 100);
  const by = Object.fromEntries(jungler.components.map((c) => [c.key, c.weight]));
  assert.ok(by.deaths < by.tempo);
  assert.ok(by.deaths < by.objectives);
  assert.ok(by.pressure > by.tempo, 'what the jungler personally did outranks the map state');
});

test('no timeline means tempo drops out rather than scoring zero', () => {
  const s = campedTopScenario();
  const scored = scoreMatch(s.match, { timeline: null, trackedPuuids: [] });
  const tempo = scored.p2.components.find((c) => c.key === 'tempo');
  assert.equal(scored.p2.context.weightedLaneGold14, null);
  assert.ok(Number.isFinite(scored.p2.composite));
  // Counter-jungling survives without a timeline, so the component still has
  // something to say; it just must not be reporting lane state it cannot see.
  assert.doesNotMatch(tempo.detail ?? '', /lanes/);
});
