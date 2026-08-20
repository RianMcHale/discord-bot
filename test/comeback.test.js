// A scaling carry who loses lane and then wins the game was being graded on the
// 14-minute snapshot as if nothing after it counted. These pin the correction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch } from '../src/scoring/index.js';
import { campedTopScenario } from './helpers/matchFixture.js';

/**
 * Builds a match where the ADC ends laning down `deficit` gold on the enemy ADC,
 * then out-earns them by `swing` over the rest of the game.
 */
function adcGame({ deficit, swing, durationMinutes = 34 }) {
  const s = campedTopScenario({ durationMinutes });
  const mine = s.match.info.participants.find((p) => p.puuid === 'p4'); // our ADC
  const theirs = s.match.info.participants.find((p) => p.puuid === 'p9'); // enemy ADC

  // Set the 14-minute state directly on the frames the scorer reads.
  const bench = s.timeline.info.frames[14];
  bench.participantFrames['4'].totalGold = 5000;
  bench.participantFrames['9'].totalGold = 5000 + deficit;

  // End-of-game gold decides the post-laning swing.
  const minePost = 12000;
  mine.goldEarned = 5000 + minePost;
  theirs.goldEarned = 5000 + deficit + minePost - swing;

  return scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
}

const laneOf = (scored) => scored.p4.components.find((c) => c.key === 'lane').score;

test('losing lane then out-earning them scores better than staying lost', () => {
  const stayedLost = adcGame({ deficit: 1100, swing: 0 });
  const cameBack = adcGame({ deficit: 1100, swing: 3000 });

  assert.ok(
    laneOf(cameBack) > laneOf(stayedLost) + 10,
    `comeback ${laneOf(cameBack)} should clearly beat ${laneOf(stayedLost)}`
  );
});

test('the credit is proportional to how much of the deficit was erased', () => {
  const partial = adcGame({ deficit: 2000, swing: 700 });
  const full = adcGame({ deficit: 2000, swing: 2500 });
  const flat = adcGame({ deficit: 2000, swing: 0 });

  assert.ok(laneOf(partial) > laneOf(flat), 'some recovery counts for something');
  assert.ok(laneOf(full) > laneOf(partial), 'erasing the whole deficit counts for more');
});

test('a comeback cannot turn a lost lane into a won one', () => {
  const cameBack = adcGame({ deficit: 1500, swing: 9000 });
  const wonLane = adcGame({ deficit: -1500, swing: 0 });

  assert.ok(laneOf(cameBack) < laneOf(wonLane), 'winning lane outright is still better');
  assert.ok(laneOf(cameBack) <= 100);
});

test('throwing a lead costs less than a comeback earns', () => {
  const held = adcGame({ deficit: -1200, swing: 0 });
  const thrown = adcGame({ deficit: -1200, swing: -4000 });
  const lost = adcGame({ deficit: 1200, swing: 0 });
  const recovered = adcGame({ deficit: 1200, swing: 4000 });

  const throwCost = laneOf(held) - laneOf(thrown);
  const comebackGain = laneOf(recovered) - laneOf(lost);

  assert.ok(throwCost > 0, 'giving a lead away should cost something');
  assert.ok(comebackGain > throwCost, 'but coming back takes more play than losing a lead does');
});

test('an even lane is untouched by the adjustment', () => {
  const even = adcGame({ deficit: 100, swing: 2000 });
  const scored = even.p4;
  assert.ok(!/post-lane/.test(scored.components.find((c) => c.key === 'lane').detail ?? ''));
});

test('a real comeback is surfaced as a note', () => {
  const scored = adcGame({ deficit: 1400, swing: 2500 });
  assert.match(scored.p4.notes.join(' '), /down 1400g @14, \+2500g after/);
});

test('the swing is reported in the stored context', () => {
  const scored = adcGame({ deficit: 900, swing: 1800 });
  assert.equal(scored.p4.context.postLaneSwing, 1800);
  assert.equal(scored.p4.context.goldDiff14, -900);
});

test('no timeline means no comeback adjustment rather than a crash', () => {
  const s = campedTopScenario();
  const scored = scoreMatch(s.match, { timeline: null, trackedPuuids: [] });
  assert.equal(scored.p4.context.postLaneSwing, null);
  assert.ok(Number.isFinite(scored.p4.composite));
});
