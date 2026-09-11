// Real matches are messier than the happy path. None of these should throw,
// and none should produce a NaN score.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch } from '../src/scoring/index.js';
import { campedTopScenario, plainMatch } from './helpers/matchFixture.js';

const allFinite = (scored) =>
  Object.values(scored).every((s) => Number.isFinite(s.composite) && s.composite >= 0 && s.composite <= 100);

test('scores without a timeline, and says the data is partial', () => {
  const scored = scoreMatch(plainMatch(), { trackedPuuids: [] });
  assert.equal(Object.keys(scored).length, 10);
  assert.ok(allFinite(scored));
  for (const s of Object.values(scored)) {
    assert.equal(s.dataQuality, 'partial');
    // Timeline-only components drop out rather than scoring zero.
    assert.equal(s.context.goldDiff14, null);
  }
});

test('a missing timeline changes the score but never breaks it', () => {
  const { match, timeline } = campedTopScenario();
  const withTl = scoreMatch(match, { timeline, trackedPuuids: [] });
  const without = scoreMatch(match, { timeline: null, trackedPuuids: [] });
  assert.ok(allFinite(without));
  assert.notEqual(withTl.p2.composite, without.p2.composite);
});

test('unusable role data is inferred where possible and conceded where not', () => {
  // Riot's teamPosition is garbage here. The spec's §5.2 chain says infer what
  // can be inferred rather than giving up on the whole lobby — and say so about
  // the rest, instead of scoring them against a counterpart that isn't there.
  const scored = scoreMatch(plainMatch({ roleFor: () => 'Invalid' }), { trackedPuuids: [] });
  assert.ok(allFinite(scored), 'every player still gets a finite score');

  // Jungle is identifiable from jungle CS alone, so it resolves.
  assert.equal(scored.p2.role, 'JUNGLE');
  assert.equal(scored.p2.roleConfidence, 'MEDIUM', 'inferred, not asserted');

  // The fixture gives nothing to identify a laner with, so those are conceded
  // rather than guessed at.
  assert.equal(scored.p3.role, 'UNKNOWN');
  assert.equal(scored.p3.roleConfidence, 'LOW');
  assert.equal(scored.p3.roleBranch, 'unresolved');
});

test('a clean lobby resolves at high confidence and says which branch', () => {
  const scored = scoreMatch(plainMatch(), { trackedPuuids: [] });
  for (const s of Object.values(scored)) {
    assert.equal(s.roleConfidence, 'HIGH');
    assert.equal(s.roleBranch, 'teamPosition');
  }
});

test('handles a non-Summoners-Rift map', () => {
  const scored = scoreMatch(plainMatch({ mapId: 12, queueId: 450 }), { trackedPuuids: [] });
  assert.ok(allFinite(scored));
  // ARAM has no lanes, so the generic rubric applies regardless of teamPosition.
  assert.equal(Object.values(scored)[0].components.length, 5);
});

test('handles a role with no opposing counterpart', () => {
  // Both of team 200's solo laners report TOP, leaving nobody in MIDDLE.
  const roleFor = (id) => (id === 8 ? 'TOP' : ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'][(id - 1) % 5]);
  const { match, timeline } = campedTopScenario();
  match.info.participants.forEach((p) => (p.teamPosition = roleFor(p.participantId)));
  const scored = scoreMatch(match, { timeline, trackedPuuids: [] });
  assert.ok(allFinite(scored));
  assert.match(scored.p3.notes.join(' '), /no opposing player/i);
});

test('refuses to score a remake', () => {
  assert.throws(
    () => scoreMatch(plainMatch({ durationSeconds: 240 }), { trackedPuuids: [] }),
    /too short to score/
  );
});

test('accepts gameDuration in milliseconds', () => {
  // Riot returned ms rather than seconds for a stretch of patches, distinguished
  // by the absence of gameEndTimestamp.
  const match = plainMatch({ durationSeconds: 1800 });
  match.info.gameDuration = 1800000;
  delete match.info.gameEndTimestamp;
  const scored = scoreMatch(match, { trackedPuuids: [] });
  assert.ok(allFinite(scored));
});

test('survives a truncated timeline', () => {
  const scored = scoreMatch(plainMatch(), {
    timeline: { info: { frames: [{ timestamp: 0, participantFrames: {}, events: [] }] } },
    trackedPuuids: []
  });
  assert.ok(allFinite(scored));
  assert.equal(Object.values(scored)[0].dataQuality, 'partial');
});

test('survives a lobby where every stat is zero', () => {
  const match = plainMatch();
  for (const p of match.info.participants) {
    Object.assign(p, {
      kills: 0, deaths: 0, assists: 0, totalDamageDealtToChampions: 0, goldEarned: 0,
      totalMinionsKilled: 0, neutralMinionsKilled: 0, visionScore: 0, wardsPlaced: 0,
      wardsKilled: 0, detectorWardsPlaced: 0, damageDealtToTurrets: 0, timeCCingOthers: 0,
      challenges: {}
    });
  }
  const scored = scoreMatch(match, { trackedPuuids: [] });
  assert.ok(allFinite(scored));
});

test('marks tracked players without affecting their scores', () => {
  const { match, timeline } = campedTopScenario();
  const none = scoreMatch(match, { timeline, trackedPuuids: [] });
  const some = scoreMatch(match, { timeline, trackedPuuids: ['p1', 'p2'] });
  assert.equal(some.p1.isTracked, true);
  assert.equal(some.p6.isTracked, false);
  assert.equal(none.p1.composite, some.p1.composite);
});
