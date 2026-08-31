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

const DAY = 86400000;

function seed(n = 3) {
  db.resetGames();
  for (let i = 0; i < n; i++) {
    // Ascending in time, so G0 is the oldest and G{n-1} the most recent.
    db.saveGame(`G${i}`, { ...gameRecord({ matchId: `G${i}`, playedAt: i * DAY, scores }), queueId: 420 });
  }
  db.upsertPlayer({ discordId: 'd1', riotGameName: 'One', riotTagLine: 'EUW', puuid: 'p1' });
}

function fakeInteraction(userId, confirm, last = null) {
  const captured = {};
  return {
    captured,
    user: { id: userId },
    options: { getString: () => confirm, getInteger: () => last },
    async reply(payload) {
      captured.payload = payload;
    }
  };
}

const idsLeft = () => db.allGames().map((g) => g.matchId);

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

// --- partial reset, for re-scoring after a scoring change --------------------

test('`last` clears only the most recent N games and keeps the rest', async () => {
  seed(6);
  const i = fakeInteraction(OWNER, 'RESET', 2);
  await cmd.execute(i);

  assert.deepEqual(idsLeft(), ['G0', 'G1', 'G2', 'G3'], 'the two newest go, the four older stay');
  assert.match(i.captured.payload.content, /Cleared the \*\*2\*\* most recent scored games/);
  assert.match(i.captured.payload.content, /The \*\*4\*\* older games were kept/);
});

test('it removes the newest by play time, not by insertion order', async () => {
  db.resetGames();
  // Written oldest-last on purpose: a naive slice of the raw object would take
  // the wrong two.
  for (const [id, day] of [['NEW', 9], ['OLD', 1], ['MID', 5]]) {
    db.saveGame(id, { ...gameRecord({ matchId: id, playedAt: day * DAY, scores }), queueId: 420 });
  }
  const i = fakeInteraction(OWNER, 'RESET', 1);
  await cmd.execute(i);
  assert.deepEqual(idsLeft(), ['OLD', 'MID']);
});

test('a partial reset still needs the confirmation word', async () => {
  seed(4);
  const i = fakeInteraction(OWNER, 'nope', 2);
  await cmd.execute(i);
  assert.match(i.captured.payload.content, /must type `RESET` exactly/);
  assert.equal(db.allGames().length, 4, 'nothing removed');
});

test('asking for more than exist clears what there is and says so', async () => {
  seed(3);
  const i = fakeInteraction(OWNER, 'RESET', 50);
  await cmd.execute(i);
  assert.equal(db.allGames().length, 0);
  assert.match(i.captured.payload.content, /Cleared the \*\*3\*\* most recent/);
  assert.match(i.captured.payload.content, /only 3 were stored/);
  // It must not claim to have kept older games when it cleared the lot.
  assert.doesNotMatch(i.captured.payload.content, /older games? were kept/);
  assert.match(i.captured.payload.content, /That was all of them/);
});

test('the reply hands over the exact command to re-score with', async () => {
  seed(9);
  const i = fakeInteraction(OWNER, 'RESET', 3);
  await cmd.execute(i);
  assert.match(i.captured.payload.content, /\/fetchgame count:3 lookback:10/);
});

test('a reset bigger than one fetch pass says how many runs it takes', async () => {
  seed(20);
  const i = fakeInteraction(OWNER, 'RESET', 12);
  await cmd.execute(i);
  // 12 games at 5 per pass is three runs, and the lookback has to grow with it.
  assert.match(i.captured.payload.content, /count:5 lookback:24/);
  assert.match(i.captured.payload.content, /\*\*3×\*\*/);
});

test('a partial reset keeps the skip cache, a full one clears it', async () => {
  // Skipped matches were never scored, so re-scoring has no business
  // reconsidering them — but a full wipe means starting over completely.
  seed(4);
  db.markSkipped('SKIPME', 'only one tracked player', 1);
  assert.equal(db.skippedCount(), 1);

  await cmd.execute(fakeInteraction(OWNER, 'RESET', 2));
  assert.equal(db.skippedCount(), 1, 'partial reset leaves it alone');

  await cmd.execute(fakeInteraction(OWNER, 'RESET'));
  assert.equal(db.skippedCount(), 0, 'full wipe clears it');
});

test('resetting with nothing stored says so rather than claiming a wipe', async () => {
  db.resetGames();
  const i = fakeInteraction(OWNER, 'RESET', 5);
  await cmd.execute(i);
  assert.match(i.captured.payload.content, /Nothing to clear/);
});
