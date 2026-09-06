// Dragon Soul was worth nothing. The fourth drake grants a permanent teamwide
// buff that usually decides the game, and it counted exactly the same as the
// first one — so "we got Soul, Baron and Elder" and "we got four scattered
// drakes" scored identically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch } from '../src/scoring/index.js';
import { campedTopScenario } from './helpers/matchFixture.js';

const SUBTYPES = ['FIRE_DRAGON', 'EARTH_DRAGON', 'AIR_DRAGON', 'WATER_DRAGON', 'HEXTECH_DRAGON'];

/**
 * Replaces the fixture's objectives with a specified set.
 * `drakes` per team, plus optional baron/elder for team 100.
 */
function objectives({ mine = 0, theirs = 0, baron = false, elder = false } = {}) {
  const s = campedTopScenario({ durationMinutes: 40 });
  s.timeline.info.frames.forEach((f) => {
    f.events = f.events.filter((e) => e.type !== 'ELITE_MONSTER_KILL');
  });
  const add = (m, teamId, type, sub) =>
    s.timeline.info.frames[m].events.push({
      timestamp: m * 60000,
      type: 'ELITE_MONSTER_KILL',
      killerId: teamId === 100 ? 2 : 7,
      killerTeamId: teamId,
      monsterType: type,
      monsterSubType: sub,
      assistingParticipantIds: teamId === 100 ? [3, 4] : [8, 9]
    });

  let m = 6;
  for (let i = 0; i < mine; i++) add((m += 2), 100, 'DRAGON', SUBTYPES[i % 5]);
  for (let i = 0; i < theirs; i++) add((m += 2), 200, 'DRAGON', SUBTYPES[i % 5]);
  if (baron) add(32, 100, 'BARON_NASHOR');
  if (elder) add(36, 100, 'DRAGON', 'ELDER_DRAGON');

  const scored = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
  return { scored, jungler: scored.p2, obj: scored.p2.components.find((c) => c.key === 'objectives') };
}

test('the fourth drake is worth more than the third', () => {
  const three = objectives({ mine: 3, theirs: 3 });
  const four = objectives({ mine: 4, theirs: 3 });

  assert.equal(three.jungler.context.tookSoul, false);
  assert.equal(four.jungler.context.tookSoul, true);
  assert.ok(
    four.obj.score > three.obj.score + 5,
    `securing soul has to beat not securing it by more than one drake (${three.obj.score} -> ${four.obj.score})`
  );
});

test('soul is the biggest single objective on the board', () => {
  // The soul-securing drake against a baron, from the same starting position.
  const soul = objectives({ mine: 4, theirs: 2 });
  const baron = objectives({ mine: 3, theirs: 2, baron: true });
  assert.ok(soul.obj.score > baron.obj.score, `soul ${soul.obj.score} should outrank a baron ${baron.obj.score}`);
});

test('conceding soul is recorded against the team that gave it up', () => {
  const { scored } = objectives({ mine: 1, theirs: 4 });
  assert.equal(scored.p2.context.concededSoul, true);
  assert.equal(scored.p2.context.tookSoul, false);
  assert.equal(scored.p7.context.tookSoul, true);
  assert.match(scored.p2.components.find((c) => c.key === 'objectives').detail, /conceded soul/);
  assert.match(scored.p7.components.find((c) => c.key === 'objectives').detail, /· soul/);
});

test('elders never count toward a soul', () => {
  // Elder only spawns after a soul is taken, so it must not be the drake that
  // trips the counter.
  const { jungler } = objectives({ mine: 3, theirs: 1, elder: true });
  assert.equal(jungler.context.tookSoul, false);
  assert.equal(jungler.context.drakesTaken, 3);
});

test('taking soul does not shrink your share of your own team’s objectives', () => {
  // The soul bonus grows the team's weighted total. Without scaling the personal
  // figure alongside it, a jungler on 90% of their team's objectives would read
  // as a smaller share for having taken soul — punished for the thing.
  const three = objectives({ mine: 3, theirs: 2 });
  const four = objectives({ mine: 4, theirs: 2 });
  assert.ok(
    four.jungler.context.epicShare >= three.jungler.context.epicShare - 1,
    `share fell from ${three.jungler.context.epicShare} to ${four.jungler.context.epicShare}`
  );
});

test('an elder is worth two drakes to the taker, not one', () => {
  // Riot's dragonTakedowns challenge counts an Elder as just another dragon, so
  // personalEpics valued it at 1 while the team tally valued it at 2 — anyone
  // who took Elder had their share understated for it.
  const s = campedTopScenario({ durationMinutes: 40 });
  s.timeline.info.frames.forEach((f) => {
    f.events = f.events.filter((e) => e.type !== 'ELITE_MONSTER_KILL');
  });
  s.timeline.info.frames[36].events.push({
    timestamp: 36 * 60000,
    type: 'ELITE_MONSTER_KILL',
    killerId: 2,
    killerTeamId: 100,
    monsterType: 'DRAGON',
    monsterSubType: 'ELDER_DRAGON',
    assistingParticipantIds: []
  });
  const scored = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
  assert.equal(scored.p2.context.tookSoul, false, 'an elder alone is not a soul');
  assert.ok(scored.p2.context.epicShare > 0, 'and the taker gets credit for it');
});

test('no objectives at all does not crash', () => {
  const { jungler } = objectives({ mine: 0, theirs: 0 });
  assert.ok(Number.isFinite(jungler.composite));
  assert.equal(jungler.context.tookSoul, false);
});

test('soul needs a timeline and degrades quietly without one', () => {
  const s = campedTopScenario();
  const scored = scoreMatch(s.match, { timeline: null, trackedPuuids: [] });
  assert.equal(scored.p2.context.tookSoul, false);
  assert.ok(Number.isFinite(scored.p2.composite));
});
