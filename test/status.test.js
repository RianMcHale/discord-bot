// /status exists to distinguish "nothing to report" from "quietly broken", so
// each test is one of the failure modes that has actually happened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, gameRecord, playerScore } from './helpers/tempDb.js';

useTempDb();
const { db } = await import('../src/storage.js');
const cmd = await import('../src/commands/status.js');

db.upsertPlayer({ discordId: 'd1', riotGameName: 'One', riotTagLine: 'EUW', puuid: 'p1' });
db.upsertPlayer({ discordId: 'd2', riotGameName: 'Two', riotTagLine: 'EUW', puuid: 'p2' });
db.saveGame('G1', {
  ...gameRecord({ matchId: 'G1', playedAt: Date.now() - 3600000, scores: { d1: playerScore({ composite: 55, role: 'TOP' }) } }),
  queueId: 420
});

/** A Riot client that fails however the test needs it to. */
function api({ failWith = null, failFor = [] } = {}) {
  return {
    async getRecentMatchIds(puuid) {
      const status = failWith && (failFor.length === 0 || failFor.includes(puuid)) ? failWith : null;
      if (status) throw Object.assign(new Error('nope'), { response: { status } });
      return ['M1'];
    }
  };
}

async function run(opts) {
  const captured = {};
  const interaction = {
    async deferReply() {},
    async editReply(payload) {
      captured.payload = payload;
    }
  };
  await cmd.execute(interaction, opts);
  return captured.payload.embeds[0].toJSON();
}

test('reports healthy when every lookup succeeds', async () => {
  const j = await run({ api: api() });
  assert.match(j.description, /✅ \*\*Riot API\*\* — key accepted/);
  assert.match(j.description, /✅ \*\*Player lookups\*\* — 2\/2 resolving/);
  assert.ok(!j.description.includes('❌'));
});

test('calls out an expired or invalid key', async () => {
  const j = await run({ api: api({ failWith: 403 }) });
  assert.match(j.description, /❌ \*\*Riot API\*\* — key rejected \(403\)/);
  assert.equal(j.color, 0xe74c3c, 'red for a hard failure');
});

test('distinguishes stale PUUIDs from a bad key', async () => {
  // The exact failure that took an evening to find: the key is fine, the stored
  // PUUIDs are not, and the scanner repairs them by itself.
  const j = await run({ api: api({ failWith: 400, failFor: ['p1'] }) });
  assert.match(j.description, /✅ \*\*Riot API\*\* — key accepted/);
  assert.match(j.description, /⚠️ \*\*Player lookups\*\* — 1\/2 resolving/);
  assert.match(j.description, /stale PUUID, repaired automatically/);
  assert.match(j.description, /stale: One/);
});

test('flags the watcher when it is not configured', async () => {
  const j = await run({ api: api() });
  assert.match(j.description, /⚠️ \*\*Watcher\*\* — disabled/);
  assert.match(j.description, /DISCORD_WATCH_CHANNEL_ID/);
});

test('reports stored data and where it lives', async () => {
  const j = await run({ api: api() });
  assert.match(j.description, /\*\*Data\*\* — 1 game, 2 players/);
  assert.match(j.description, /db\.json/);
});

test('summarises the environment it is actually running against', async () => {
  const j = await run({ api: api() });
  assert.match(j.footer.text, /rolling window/);
  assert.match(j.footer.text, /queues 400, 420/);
});

test('does not fail when no players are registered', async () => {
  db.resetGames();
  const fresh = await import(`../src/commands/status.js?v=${Math.random()}`);
  const captured = {};
  await fresh.execute(
    { async deferReply() {}, async editReply(p) { captured.payload = p; } },
    { api: api({ failWith: 500 }) }
  );
  assert.ok(captured.payload.embeds[0].toJSON().description.length > 0);
});
