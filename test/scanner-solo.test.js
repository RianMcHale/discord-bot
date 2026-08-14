// Needs its own database: the store is module-scoped, and this is the only case
// that requires a roster too small to scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers/tempDb.js';

useTempDb();
const { db } = await import('../src/storage.js');
const { scanForNewGames } = await import('../src/scanner.js');

test('declines to scan with fewer than two registered players', async () => {
  const api = {
    async getRecentMatchIds() {
      throw new Error('should never reach the Riot API with an incomplete roster');
    },
    async getMatch() {
      throw new Error('unreachable');
    },
    async getTimeline() {
      throw new Error('unreachable');
    }
  };

  const empty = await scanForNewGames({ api });
  assert.equal(empty.tooFewPlayers, true);

  db.upsertPlayer({ discordId: 'only', riotGameName: 'Solo', riotTagLine: 'EUW', puuid: 'p1' });
  const one = await scanForNewGames({ api });
  assert.equal(one.tooFewPlayers, true, 'one player cannot share a match with anyone');
  assert.equal(one.scored.length, 0);
});
