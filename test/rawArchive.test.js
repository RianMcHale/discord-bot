// Keeping the raw payloads (spec Phase 1, finding F9).
//
// The bot used to fetch a match, score it, store the scores and throw the
// payload away. That was merely wasteful until the seven-day fetch window went
// in; now it is one-way. A scoring change applies to last week's games and
// nothing else, because Riot will not hand the older ones back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers/tempDb.js';
import { campedTopScenario } from './helpers/matchFixture.js';

useTempDb();
const { db } = await import('../src/storage.js');
const rawArchive = await import('../src/rawArchive.js');
const { rescoreStored, coverage } = await import('../src/rescore.js');
const { scoreMatch } = await import('../src/scoring/index.js');

const scenario = () => campedTopScenario({ durationMinutes: 32 });

test('a payload survives the round trip intact', () => {
  const { match, timeline } = scenario();
  rawArchive.save('EUW1_ROUNDTRIP', { match, timeline });

  const back = rawArchive.load('EUW1_ROUNDTRIP');
  assert.ok(back, 'it has to come back');
  // Deep equality, not a spot check: a score computed from a lossy copy is not
  // the same score, which defeats the point of keeping it.
  assert.deepEqual(back.match, match);
  assert.deepEqual(back.timeline, timeline);
  assert.ok(back.archivedAt > 0);
});

test('it compresses enough to be worth doing', () => {
  const { match, timeline } = scenario();
  const raw = Buffer.byteLength(JSON.stringify({ match, timeline }));
  const stored = rawArchive.save('EUW1_SIZE', { match, timeline });

  assert.ok(stored < raw, 'gzipped must be smaller than not');
  // Riot payloads are the same forty fields per participant per minute, so they
  // compress hard. Anything under 3:1 would mean the format changed shape and
  // the disk cost is worth re-checking.
  assert.ok(raw / stored > 3, `expected better than 3:1, got ${(raw / stored).toFixed(1)}:1`);
});

test('a match id that is not a match id is refused, not turned into a path', () => {
  // The id becomes a filename, so it is checked rather than trusted.
  assert.equal(rawArchive.save('../../etc/passwd', { match: {} }), null);
  assert.equal(rawArchive.save('has spaces', { match: {} }), null);
  assert.equal(rawArchive.has('../../etc/passwd'), false);
});

test('a missing or unreadable archive reads as absent rather than throwing', () => {
  assert.equal(rawArchive.load('EUW1_NEVER_STORED'), null);
  assert.equal(rawArchive.has('EUW1_NEVER_STORED'), false);
});

test('stats report what it is actually costing', () => {
  const { match, timeline } = scenario();
  for (const id of ['EUW1_S1', 'EUW1_S2', 'EUW1_S3']) rawArchive.save(id, { match, timeline });

  const s = rawArchive.stats();
  assert.ok(s.games >= 3);
  assert.ok(s.bytes > 0);
  assert.ok(s.perGameKb > 0, 'a size nobody can see is a size nobody will manage');
});

// --- what the archive is for -------------------------------------------------

/** Stores a game the way the scanner does, with its payload archived. */
function storeScored(matchId, { tamper = null } = {}) {
  const { match, timeline } = scenario();
  match.metadata.matchId = matchId;
  const scores = scoreMatch(match, { timeline, trackedPuuids: ['p1', 'p2'] });
  const byId = { d1: scores.p1, d2: scores.p2 };
  // What the current model says, captured before the stored copy is spoiled —
  // this is what a correct re-score has to land back on.
  const truth = { d1: byId.d1.composite, d2: byId.d2.composite };
  if (tamper) tamper(byId);

  rawArchive.save(matchId, { match, timeline });
  db.saveGame(matchId, {
    matchId,
    playedAt: Date.now() - 1000,
    queueId: 420,
    durationSeconds: 32 * 60,
    dataQuality: 'full',
    scores: byId
  });
  return truth;
}

test('a game scored by an older model is corrected without touching Riot', () => {
  // The point of the whole exercise. The stored score here is deliberately wrong
  // — as if it had been produced by a model two changes ago — and re-scoring
  // from the payload puts it right.
  db.resetGames();
  db.upsertPlayer({ discordId: 'd1', riotGameName: 'One', riotTagLine: 'EUW', puuid: 'p1' });
  db.upsertPlayer({ discordId: 'd2', riotGameName: 'Two', riotTagLine: 'EUW', puuid: 'p2' });

  const truth = storeScored('EUW1_STALE', {
    tamper: (byId) => {
      byId.d1 = { ...byId.d1, composite: 99.9 };
    }
  });

  const before = db.allGames()[0].scores.d1.composite;
  assert.equal(before, 99.9);

  const result = rescoreStored({ dryRun: false });
  return Promise.resolve(result).then((r) => {
    assert.equal(r.rescored, 1);
    assert.equal(r.missingPayload, 0);
    const after = db.allGames()[0].scores.d1.composite;
    assert.notEqual(after, 99.9, 'the stale score must be replaced');
    assert.ok(Math.abs(after - truth.d1) < 0.01, 'and replaced with what the current model says');
  });
});

test('a preview changes nothing', async () => {
  db.resetGames();
  storeScored('EUW1_PREVIEW', {
    tamper: (byId) => {
      byId.d1 = { ...byId.d1, composite: 12.3 };
    }
  });

  const r = await rescoreStored({ dryRun: true });
  assert.equal(r.rescored, 1, 'it still reports what would change');
  assert.equal(db.allGames()[0].scores.d1.composite, 12.3, 'but writes nothing');
});

test('games with no archived payload are left alone, not dropped', async () => {
  // Everything scored before archiving existed. Deleting somebody's history to
  // tidy up a version number is a worse outcome than carrying an old score.
  db.resetGames();
  db.saveGame('EUW1_ANCIENT', {
    matchId: 'EUW1_ANCIENT',
    playedAt: Date.now() - 90 * 24 * 3600e3,
    queueId: 420,
    durationSeconds: 1800,
    dataQuality: 'full',
    scores: { d1: { composite: 55, role: 'TOP', champion: 'X', kda: '1/1/1', win: true, components: [] } }
  });

  const r = await rescoreStored({ dryRun: false });
  assert.equal(r.missingPayload, 1);
  assert.equal(r.rescored, 0);
  assert.equal(db.allGames().length, 1, 'the game is still there');
  assert.equal(db.allGames()[0].scores.d1.composite, 55, 'with its score untouched');
});

test('re-scoring twice is a no-op the second time', async () => {
  // Determinism, at the level that matters here: the same payload through the
  // same model gives the same score, so a second run finds nothing to change.
  db.resetGames();
  storeScored('EUW1_TWICE');

  await rescoreStored({ dryRun: false });
  const second = await rescoreStored({ dryRun: false });
  assert.equal(second.rescored, 0, 'nothing moved on the second pass');
  assert.ok(second.unchanged >= 1);
});

test('coverage says how much of history can be reached', () => {
  db.resetGames();
  storeScored('EUW1_COV1');
  db.saveGame('EUW1_COV2', {
    matchId: 'EUW1_COV2',
    playedAt: Date.now(),
    queueId: 420,
    durationSeconds: 1800,
    dataQuality: 'full',
    scores: { d1: { composite: 50, components: [] } }
  });

  const c = coverage();
  assert.equal(c.stored, 2);
  assert.equal(c.covered, 1);
  assert.equal(c.missing, 1);
  assert.equal(c.pct, 50);
});

test('the report names the biggest movers, not just a count', async () => {
  // "Nothing moved by more than 0.4" and "one game moved 22 points" are
  // different outcomes and must not read the same.
  db.resetGames();
  storeScored('EUW1_MOVER', {
    tamper: (byId) => {
      byId.d1 = { ...byId.d1, composite: 10 };
    }
  });

  const r = await rescoreStored({ dryRun: true });
  assert.equal(r.movers.length, 1);
  assert.equal(r.movers[0].discordId, 'd1');
  assert.ok(r.movers[0].delta > 20, 'a 40-point correction should report as one');
});
