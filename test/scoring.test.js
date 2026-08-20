// The two judgements the role-based model exists to make correctly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch } from '../src/scoring/index.js';
import { campedTopScenario } from './helpers/matchFixture.js';

const { match, timeline, puuids } = campedTopScenario();
const scored = scoreMatch(match, { timeline, trackedPuuids: [] });

const jungler = scored[puuids.farmingJungler];
const top = scored[puuids.campedTop];
const enemyJungler = scored[puuids.enemyJungler];

test('a jungler with a good KDA but no map impact scores badly', () => {
  // 3/2/9 with the fewest deaths in the lobby. A deaths-weighted composite rated
  // this player mid-table; the role rubric should not.
  assert.ok(jungler.composite < 40, `expected under 40, got ${jungler.composite}`);
  assert.equal(jungler.grade, 'F');
});

test('the farming jungler is graded on objectives and lane state, not deaths', () => {
  const by = Object.fromEntries(jungler.components.map((c) => [c.key, c]));
  // Their best component is death discipline — and it must not rescue the score.
  assert.ok(by.deaths.score > 60, 'low deaths should still score well in isolation');
  assert.ok(by.objectives.score < 40, 'lost objective control should score badly');
  assert.ok(by.mapstate.score < 30, 'all three lanes behind at 14 should score badly');
  assert.equal(by.pressure.score, 0, 'no gank impact at all');
  // Deaths are the lightest weight in the jungle rubric on purpose.
  assert.ok(by.deaths.weight < by.objectives.weight);
  assert.ok(by.deaths.weight < by.mapstate.weight);
});

test('a camped top laner is not the worst player in the game', () => {
  // 1/7/2 and 1600 gold down. Under a lobby-wide composite this was last by a
  // wide margin; the jungler who left them there should rank below.
  assert.ok(top.composite > jungler.composite, `top ${top.composite} should beat jungler ${jungler.composite}`);
});

test('jungle pressure is measured and lowers the camped laner’s lane bar', () => {
  assert.ok(top.context.netJunglePressure >= 3, `expected sustained pressure, got ${top.context.netJunglePressure}`);
  assert.match(top.notes.join(' '), /camped/i);

  // The same gold deficit without any pressure must score strictly worse.
  const { match: clean, timeline: cleanTimeline } = campedTopScenario();
  for (const frame of cleanTimeline.info.frames) {
    frame.events = frame.events.filter((e) => !(e.type === 'CHAMPION_KILL' && e.victimId === 1));
    // Move the enemy jungler off top lane entirely.
    if (frame.participantFrames['7']) frame.participantFrames['7'].position = { x: 9000, y: 8000 };
  }
  const uncamped = scoreMatch(clean, { timeline: cleanTimeline, trackedPuuids: [] })[puuids.campedTop];
  const laneOf = (s) => s.components.find((c) => c.key === 'lane').score;
  assert.ok(laneOf(top) > laneOf(uncamped), 'being camped should raise the lane score for the same deficit');
});

test('the jungler who created the pressure is credited for it', () => {
  const by = Object.fromEntries(enemyJungler.components.map((c) => [c.key, c]));
  assert.ok(by.pressure.score > 80, `expected high gank impact, got ${by.pressure.score}`);
  assert.ok(enemyJungler.composite > 65);
});

test('every player scores on their own role rubric', () => {
  const keysFor = (puuid) => scored[puuid].components.map((c) => c.key).sort().join(',');
  assert.notEqual(keysFor(puuids.farmingJungler), keysFor(puuids.campedTop));
  assert.notEqual(keysFor(puuids.support), keysFor(puuids.adc));
  // Non-lane weights are fixed and total the same in every game; the lane weight
  // is the one that moves, so the sum sits just under 100 in a long game.
  for (const s of Object.values(scored)) {
    const total = s.components.reduce((a, c) => a + c.weight, 0);
    assert.ok(total >= 90 && total <= 105, `${s.role} weights out of range: ${total}`);
  }
});

test('the lane snapshot counts for less the longer the game runs', () => {
  const laneWeightIn = (minutes) => {
    const s = campedTopScenario({ durationMinutes: minutes });
    const scores = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
    return scores[s.puuids.mid].components.find((c) => c.key === 'lane').weight;
  };

  // Laning is most of a 20-minute game and a prelude to a 45-minute one. A
  // late-scaling champion shouldn't be graded as if minute 14 decided the match.
  const short = laneWeightIn(20);
  const reference = laneWeightIn(27);
  const long = laneWeightIn(45);

  assert.ok(short > reference, `short game should weight lane more (${short} vs ${reference})`);
  assert.ok(long < reference, `long game should weight lane less (${long} vs ${reference})`);
  assert.ok(long >= reference * 0.45, 'but never to nothing');
});

test('scores stay inside 0-100 and are always finite', () => {
  for (const [puuid, s] of Object.entries(scored)) {
    assert.ok(Number.isFinite(s.composite), `${puuid} composite is not finite`);
    assert.ok(s.composite >= 0 && s.composite <= 100, `${puuid} composite out of range: ${s.composite}`);
    for (const c of s.components) {
      assert.ok(c.score === null || (c.score >= 0 && c.score <= 100), `${puuid} ${c.key} out of range`);
    }
  }
});
