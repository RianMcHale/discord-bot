import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, gameRecord, playerScore } from './helpers/tempDb.js';

useTempDb();
const { db } = await import('../src/storage.js');
const { purgeUnsupportedGames } = await import('../src/maintenance.js');

const scores = { u1: playerScore({ composite: 50, role: 'TOP' }) };
const save = (matchId, queueId) => db.saveGame(matchId, gameRecord({ matchId, playedAt: Date.now(), scores, queueId }));

test('removes stored ARAM and Arena games but keeps Summoner’s Rift', () => {
  db.resetGames();
  db.saveGame('SR1', { ...gameRecord({ matchId: 'SR1', playedAt: 1, scores }), queueId: 420 });
  db.saveGame('SR2', { ...gameRecord({ matchId: 'SR2', playedAt: 2, scores }), queueId: 400 });
  db.saveGame('ARAM1', { ...gameRecord({ matchId: 'ARAM1', playedAt: 3, scores }), queueId: 450 });
  db.saveGame('ARENA1', { ...gameRecord({ matchId: 'ARENA1', playedAt: 4, scores }), queueId: 1700 });

  const result = purgeUnsupportedGames();

  assert.equal(result.removed, 2);
  assert.deepEqual(result.byQueue, { ARAM: 1, Arena: 1 });
  assert.deepEqual(db.allGames().map((g) => g.matchId).sort(), ['SR1', 'SR2']);
});

test('leaves games with no recorded queue alone rather than guessing', () => {
  db.resetGames();
  db.saveGame('OLD', { matchId: 'OLD', playedAt: 1, scores });
  const result = purgeUnsupportedGames();
  assert.equal(result.removed, 0);
  assert.equal(db.allGames().length, 1);
});

test('is a no-op on a clean database, and safe to run repeatedly', () => {
  db.resetGames();
  save('SR1', 420);
  assert.equal(purgeUnsupportedGames().removed, 0);
  assert.equal(purgeUnsupportedGames().removed, 0);
  assert.equal(db.allGames().length, 1);
});
