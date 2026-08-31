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

// The comeback lived inside laneComponent, which the jungle rubric never calls —
// so four of five roles got it and the jungler silently got nothing.
const ROLE_OF = { 1: 'TOP', 2: 'JUNGLE', 3: 'MIDDLE', 4: 'BOTTOM', 5: 'UTILITY' };
const LANE_KEY = (id) => (id === 2 ? 'tempo' : 'lane');

/** Puts all of team 100 behind at 14, optionally recovering afterwards. */
function wholeTeam({ recover }) {
  const s = campedTopScenario({ durationMinutes: 32 });
  for (const id of [1, 2, 3, 4, 5]) {
    const opp = id + 5;
    s.timeline.info.frames.forEach((f, m) => {
      if (m > 14) return;
      f.participantFrames[String(id)].totalGold = Math.round((5000 * m) / 14);
      f.participantFrames[String(opp)].totalGold = Math.round((6200 * m) / 14);
    });
    s.match.info.participants.find((p) => p.participantId === id).goldEarned = 17000 + (recover ? 2500 : 0);
    s.match.info.participants.find((p) => p.participantId === opp).goldEarned = 18200;
  }
  return scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
}

test('every role is credited for a comeback, jungle included', () => {
  const flat = wholeTeam({ recover: false });
  const back = wholeTeam({ recover: true });

  for (const id of [1, 2, 3, 4, 5]) {
    const key = LANE_KEY(id);
    const before = flat[`p${id}`].components.find((c) => c.key === key).score;
    const after = back[`p${id}`].components.find((c) => c.key === key).score;
    assert.ok(after > before + 10, `${ROLE_OF[id]} got no comeback credit (${before} -> ${after})`);
  }
});

test('the jungler’s comeback is measured across their lanes, not their own gold', () => {
  const back = wholeTeam({ recover: true });
  const tempo = back.p2.components.find((c) => c.key === 'tempo');
  // Summed over the three lane *zones*, and bot lane's zone holds two players:
  // (2500 + 2500 + 5000) / 3 zones, rescaled back to three lanes, is 10000.
  assert.match(tempo.detail, /lanes -\d+g @14/);
  assert.match(tempo.detail, /post-lane \(\+10000g\)/, 'lane-scale, not the jungler’s own 2500');
});

test('bot lane recovery is measured on the pair, like its deficit is', () => {
  // The deficit uses the pair's combined economy, so the recovery has to as
  // well — otherwise a support is credited for their ADC's comeback.
  const back = wholeTeam({ recover: true });
  const support = back.p5.components.find((c) => c.key === 'lane');
  assert.match(support.detail, /-2400g @14/, 'pair deficit');
  assert.match(support.detail, /post-lane \(\+5000g\)/, 'pair recovery, not one player’s 2500');
});

test('no timeline means no comeback adjustment rather than a crash', () => {
  const s = campedTopScenario();
  const scored = scoreMatch(s.match, { timeline: null, trackedPuuids: [] });
  assert.equal(scored.p4.context.postLaneSwing, null);
  assert.ok(Number.isFinite(scored.p4.composite));
});
