import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, gameRecord, playerScore } from './helpers/tempDb.js';

useTempDb();
const { db } = await import('../src/storage.js');
const { purgeUnsupportedGames } = await import('../src/maintenance.js');
const { queueName } = await import('../src/queues.js');

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

// The startup purge and the scanner disagreed about what counts as supported,
// and the purge ran with less information. Ranked 5s (queue 710) was accepted by
// the scanner on the structural check, deleted here on every boot, then
// re-found and re-posted by the watcher — the same three games returning after
// every deploy, forever.
test('a queue the scanner accepted is not deleted at the next boot', () => {
  db.resetGames();
  const store = (matchId, queueId) =>
    db.saveGame(matchId, {
      ...gameRecord({ matchId, playedAt: 1, scores: { a: playerScore({ composite: 50, role: 'TOP' }) } }),
      queueId
    });

  store('RANKED5S', 710); // not on the old accept list, structurally a normal Rift game
  store('SOLOQ', 420);
  store('ARAM', 450);

  const { removed } = purgeUnsupportedGames();
  assert.equal(removed, 1, 'only the ARAM game');
  assert.deepEqual(
    db.allGames().map((g) => g.matchId).sort(),
    ['RANKED5S', 'SOLOQ'],
    'a startup task that knows less than the scanner must not overrule it'
  );
});

test('an unrecognised queue is left alone rather than assumed bad', () => {
  // The next queue Riot invents must not be deleted on every restart for the
  // sole reason that nobody has heard of it yet.
  db.resetGames();
  db.saveGame('FUTURE', {
    ...gameRecord({ matchId: 'FUTURE', playedAt: 1, scores: { a: playerScore({ composite: 50, role: 'TOP' }) } }),
    queueId: 999999
  });
  assert.equal(purgeUnsupportedGames().removed, 0);
  assert.equal(db.allGames().length, 1);
});

test('BLOCKED_QUEUES is still honoured by the purge', async () => {
  const { config } = await import('../src/config.js');
  const original = config.blockedQueues;
  try {
    db.resetGames();
    db.saveGame('SWIFT', {
      ...gameRecord({ matchId: 'SWIFT', playedAt: 1, scores: { a: playerScore({ composite: 50, role: 'TOP' }) } }),
      queueId: 480
    });
    assert.equal(purgeUnsupportedGames().removed, 0, 'not blocked, so kept');

    config.blockedQueues = [480];
    assert.equal(purgeUnsupportedGames().removed, 1, 'blocking is how you actually exclude one');
  } finally {
    config.blockedQueues = original;
  }
});

test('queue 710 is named rather than shown as a bare number', () => {
  assert.equal(queueName(710), 'Ranked 5s');
});
