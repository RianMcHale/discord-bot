// The skip cache is what stops every solo queue game being re-fetched from Riot
// on every scan, so its invalidation rules matter more than they look.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDb, gameRecord, playerScore } from './helpers/tempDb.js';

const dir = useTempDb();
const { db, dbPath } = await import('../src/storage.js');

test('creates the database on first use', () => {
  db.allPlayers();
  assert.ok(fs.existsSync(dbPath));
  assert.equal(path.dirname(dbPath), dir);
});

test('remembers a rejected match so it is never re-fetched', () => {
  db.markSkipped('M_SOLO', 'only 1 registered player played', 6);
  assert.equal(db.isSkipped('M_SOLO', 6), true);
});

test('re-checks rejected matches when the roster changes', () => {
  // A match rejected for having too few tracked players may qualify once someone
  // new registers, so the cache must not outlive the roster it was built against.
  db.markSkipped('M_MAYBE', 'only 1 registered player played', 6);
  assert.equal(db.isSkipped('M_MAYBE', 6), true);
  assert.equal(db.isSkipped('M_MAYBE', 7), false, 'a new registration should invalidate the skip');
});

test('bulk skip marking writes once and reads back', () => {
  db.markManySkipped([{ matchId: 'A', reason: 'x' }, { matchId: 'B', reason: 'y' }], 6);
  assert.equal(db.isSkipped('A', 6), true);
  assert.equal(db.isSkipped('B', 6), true);
  assert.equal(db.isSkipped('C', 6), false);
});

test('markManySkipped on an empty list is a no-op', () => {
  assert.doesNotThrow(() => db.markManySkipped([], 6));
});

test('resetGames clears games and the skip cache but keeps players', () => {
  db.upsertPlayer({ discordId: 'u1', riotGameName: 'A', riotTagLine: 'E', puuid: 'pa' });
  db.saveGame('M1', gameRecord({ matchId: 'M1', playedAt: 1, scores: { u1: playerScore({ composite: 60, role: 'TOP' }) } }));
  db.markSkipped('M_X', 'nope', 6);

  db.resetGames();

  assert.equal(db.allGames().length, 0);
  assert.equal(db.isSkipped('M_X', 6), false, 'a reset should allow a full re-scan');
  assert.equal(db.allPlayers().length, 1, 'players survive a reset');
});

test('reads a database written by an older version', () => {
  // Older files have no `skipped`/`meta` keys and carry a now-removed `votes` key.
  fs.writeFileSync(dbPath, JSON.stringify({ players: { u9: { discordId: 'u9', riotGameName: 'Old', riotTagLine: 'E', puuid: 'p9' } }, games: {}, votes: { M: { a: { b: 5 } } } }));
  assert.equal(db.allPlayers().length, 1);
  assert.equal(db.isSkipped('anything', 1), false);
  assert.equal(db.getMeta('commandHash'), null);
  assert.doesNotThrow(() => db.setMeta('commandHash', 'abc'));
  assert.equal(db.getMeta('commandHash'), 'abc');
});

test('gamesForPlayer returns most recent first and respects the limit', () => {
  db.resetGames();
  db.upsertPlayer({ discordId: 'u1', riotGameName: 'A', riotTagLine: 'E', puuid: 'pa' });
  for (let i = 0; i < 5; i++) {
    db.saveGame(`G${i}`, gameRecord({ matchId: `G${i}`, playedAt: 1000 + i, scores: { u1: playerScore({ composite: 50 + i, role: 'TOP' }) } }));
  }
  const recent = db.gamesForPlayer('u1', 3);
  assert.deepEqual(recent.map((g) => g.matchId), ['G4', 'G3', 'G2']);
  assert.equal(db.gamesForPlayer('u1').length, 5, 'no limit returns everything');
});

// Widening which queues are supported used to leave every game already turned
// away permanently skipped, so a fix to the queue filter never reached the games
// it was written for.
test('a rejection only stands while the rules that produced it still hold', () => {
  db.markSkipped('M1', 'not a tracked queue', 6, 'v1:400,420');
  assert.equal(db.isSkipped('M1', 6, 'v1:400,420'), true, 'same rules, still skipped');
  assert.equal(db.isSkipped('M1', 6, 'v2:400,420,9999'), false, 'rules widened, re-check it');
});

test('rejections written before rules were versioned are re-checked once', () => {
  const state = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
  state.skipped.LEGACY = { reason: 'old rejection', rosterCount: 6 };
  fs.writeFileSync(dbPath, JSON.stringify(state));
  assert.equal(db.isSkipped('LEGACY', 6, 'v2:400,420'), false);
});

test('the roster guard still applies independently of the rules guard', () => {
  db.markSkipped('M2', 'only one tracked player', 4, 'v2:400,420');
  assert.equal(db.isSkipped('M2', 4, 'v2:400,420'), true);
  assert.equal(db.isSkipped('M2', 5, 'v2:400,420'), false, 'someone registered, so re-check');
});

test('bulk rejections carry the rules key too', () => {
  db.markManySkipped([{ matchId: 'M3', reason: 'x' }, { matchId: 'M4', reason: 'y' }], 6, 'v2:400,420');
  assert.equal(db.isSkipped('M3', 6, 'v2:400,420'), true);
  assert.equal(db.isSkipped('M4', 6, 'v9:nope'), false);
});
