// /resetgames is the only irreversible command, so the guard gets its own tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, gameRecord, playerScore } from './helpers/tempDb.js';

const OWNER = '323144087828168724';
process.env.ADMIN_USER_IDS = OWNER;
useTempDb();

const { db } = await import('../src/storage.js');
const { isAdmin } = await import('../src/config.js');
const cmd = await import('../src/commands/resetgames.js');

const scores = { d1: playerScore({ composite: 50, role: 'TOP' }) };

function seed(n = 3) {
  db.resetGames();
  for (let i = 0; i < n; i++) {
    db.saveGame(`G${i}`, { ...gameRecord({ matchId: `G${i}`, playedAt: i, scores }), queueId: 420 });
  }
  db.upsertPlayer({ discordId: 'd1', riotGameName: 'One', riotTagLine: 'EUW', puuid: 'p1' });
}

function fakeInteraction(userId, confirm) {
  const captured = {};
  return {
    captured,
    user: { id: userId },
    options: { getString: () => confirm },
    async reply(payload) {
      captured.payload = payload;
    }
  };
}

test('isAdmin only accepts the configured owner', () => {
  assert.equal(isAdmin(OWNER), true);
  assert.equal(isAdmin('245632283128758272'), false);
  assert.equal(isAdmin(''), false);
  assert.equal(isAdmin(undefined), false);
});

test('a non-owner cannot reset, even with the correct confirmation', () => {
  seed(3);
  const i = fakeInteraction('245632283128758272', 'RESET');
  return cmd.execute(i).then(() => {
    assert.match(i.captured.payload.content, /restricted to the bot owner/);
    assert.equal(i.captured.payload.ephemeral, true, 'the refusal should not spam the channel');
    assert.equal(db.allGames().length, 3, 'history survives');
  });
});

test('the owner still needs the confirmation word', async () => {
  seed(3);
  const i = fakeInteraction(OWNER, 'reset'); // wrong case
  await cmd.execute(i);
  assert.match(i.captured.payload.content, /must type `RESET` exactly/);
  assert.equal(db.allGames().length, 3, 'history survives');
});

test('the owner with the confirmation word clears games but keeps players', async () => {
  seed(3);
  const i = fakeInteraction(OWNER, 'RESET');
  await cmd.execute(i);
  assert.match(i.captured.payload.content, /Cleared \*\*3\*\* scored games/);
  assert.equal(db.allGames().length, 0);
  assert.equal(db.allPlayers().length, 1, 'registered players are kept');
});

test('permission is checked before the confirmation word', async () => {
  // A stranger typing the wrong word should learn nothing about what the right
  // one would have been.
  seed(1);
  const i = fakeInteraction('999', 'nonsense');
  await cmd.execute(i);
  assert.match(i.captured.payload.content, /restricted/);
  assert.ok(!/RESET/.test(i.captured.payload.content));
});
