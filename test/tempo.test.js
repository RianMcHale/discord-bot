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
