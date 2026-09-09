// Corrections forced by the schema probe (docs/field-audit.md), not by opinion.
//
// The audit spec's §F8 said the 2026 season invalidated several assumptions any
// pre-2026 scoring model was built on. Running scripts/schema-probe.mjs over 45
// real matches on patch 16.16-16.17 confirmed three of them and settled a
// fourth, and the code was wrong on all of them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch } from '../src/scoring/index.js';
import { buildContext } from '../src/scoring/context.js';
import { campedTopScenario } from './helpers/matchFixture.js';

/** Puts `early` plates before 14:00 and `late` plates after, for participant 1. */
function plates({ early, late }) {
  const s = campedTopScenario({ durationMinutes: 32 });
  s.timeline.info.frames.forEach((f) => {
    f.events = f.events.filter((e) => e.type !== 'TURRET_PLATE_DESTROYED');
  });
  const add = (m) =>
    s.timeline.info.frames[m].events.push({
      timestamp: m * 60000,
      type: 'TURRET_PLATE_DESTROYED',
      killerId: 1,
      laneType: 'TOP_LANE',
      teamId: 200
    });
  for (let i = 0; i < early; i++) add(6 + i);
  for (let i = 0; i < late; i++) add(18 + i);
  return s;
}

test('plates are split by phase, because most of them now land after laning', () => {
  // Measured: 1683 of 2381 plate events across 45 matches (70.7%) after 14:00.
  // Plates persist now and tier 2 and 3 turrets carry them, so the whole-game
  // total is a split-push figure wearing a laning label.
  const s = plates({ early: 2, late: 9 });
  const ctx = buildContext(s.match, s.timeline);
  const top = ctx.players.find((p) => p.participantId === 1);

  assert.equal(top.platesEarly, 2);
  assert.equal(top.platesLate, 9);
  assert.equal(top.platesPhaseKnown, true);
});

test('a split-pusher does not read as having won lane', () => {
  const sideLane = (spec) => {
    const s = plates(spec);
    return scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] })
      .p1.components.find((c) => c.key === 'sidelane').score;
  };
  // Same eleven plates. One player took them in lane, the other took them at 20
  // minutes on the far side of the map.
  const wonLane = sideLane({ early: 9, late: 2 });
  const splitPushed = sideLane({ early: 2, late: 9 });
  assert.ok(wonLane > splitPushed + 5, `${wonLane} vs ${splitPushed} — these are not the same game`);
});

test('without a timeline the plate term drops out rather than guessing', () => {
  // The phase is unknowable from the challenges total alone, and asserting a
  // lane result from it is exactly the error being fixed.
  const s = campedTopScenario();
  const scored = scoreMatch(s.match, { timeline: null, trackedPuuids: [] });
  const detail = scored.p1.components.find((c) => c.key === 'sidelane').detail;
  assert.doesNotMatch(detail, /early plates/, 'must not claim an early-plate count it cannot see');
  assert.ok(Number.isFinite(scored.p1.composite), 'and the component still scores');
});

test('Atakhan is gone from the objective weights', async () => {
  // Removed from Summoner's Rift for the 2026 season; the probe saw zero ATAKHAN
  // events in 45 matches. A stale entry in the weight table is how a scoring
  // model quietly keeps grading a patch that no longer exists.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/scoring/context.js', import.meta.url), 'utf-8')
  );
  const table = src.slice(src.indexOf('const EPIC_WEIGHT'), src.indexOf('function epicWeight'));
  assert.doesNotMatch(table, /^\s*ATAKHAN:/m, 'ATAKHAN should not carry a weight');
});

test('an unrecognised objective still scores rather than crashing', () => {
  // The other half of removing Atakhan: whatever Riot adds next must not throw.
  const s = campedTopScenario({ durationMinutes: 30 });
  s.timeline.info.frames[20].events.push({
    timestamp: 20 * 60000,
    type: 'ELITE_MONSTER_KILL',
    killerId: 2,
    killerTeamId: 100,
    monsterType: 'SOME_FUTURE_MONSTER',
    assistingParticipantIds: []
  });
  const scored = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
  assert.ok(Number.isFinite(scored.p2.composite));
});

test('soul comes from Riot’s own event, not from counting to four', () => {
  // DRAGON_SOUL_GIVEN exists — 50 of them across 45 probed matches. Counting
  // drakes ourselves was an inference standing in for a fact.
  const s = campedTopScenario({ durationMinutes: 35 });
  s.timeline.info.frames.forEach((f) => {
    f.events = f.events.filter((e) => e.type !== 'ELITE_MONSTER_KILL');
  });
  const drake = (m, sub) =>
    s.timeline.info.frames[m].events.push({
      timestamp: m * 60000, type: 'ELITE_MONSTER_KILL', killerId: 2, killerTeamId: 100,
      monsterType: 'DRAGON', monsterSubType: sub, assistingParticipantIds: []
    });
  ['FIRE_DRAGON', 'EARTH_DRAGON', 'AIR_DRAGON', 'WATER_DRAGON'].forEach((sub, i) => drake(8 + i * 4, sub));
  s.timeline.info.frames[20].events.push({ timestamp: 20 * 60000, type: 'DRAGON_SOUL_GIVEN', teamId: 100, name: 'Fire' });

  const scored = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
  assert.equal(scored.p2.context.tookSoul, true);
  assert.equal(scored.p7.context.concededSoul, true);
});

test('the drake count still covers a timeline with no soul event', () => {
  const s = campedTopScenario({ durationMinutes: 35 });
  s.timeline.info.frames.forEach((f) => {
    f.events = f.events.filter((e) => e.type !== 'ELITE_MONSTER_KILL');
  });
  ['FIRE_DRAGON', 'EARTH_DRAGON', 'AIR_DRAGON', 'WATER_DRAGON'].forEach((sub, i) =>
    s.timeline.info.frames[8 + i * 4].events.push({
      timestamp: (8 + i * 4) * 60000, type: 'ELITE_MONSTER_KILL', killerId: 2, killerTeamId: 100,
      monsterType: 'DRAGON', monsterSubType: sub, assistingParticipantIds: []
    })
  );
  const scored = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
  assert.equal(scored.p2.context.tookSoul, true, 'four drakes and no event is still a soul');
});
