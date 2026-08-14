// /match rebuilds a scorecard entirely from storage — no Riot calls — so the
// stored record has to carry everything the live path had.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, gameRecord, playerScore } from './helpers/tempDb.js';

useTempDb();
const { db } = await import('../src/storage.js');
const cmd = await import('../src/commands/match.js');

db.upsertPlayer({ discordId: 'd1', riotGameName: 'One', riotTagLine: 'EUW', puuid: 'p1' });
db.upsertPlayer({ discordId: 'd2', riotGameName: 'Two', riotTagLine: 'EUW', puuid: 'p2' });

const scores = {
  d1: playerScore({ composite: 61.2, role: 'MIDDLE', champion: 'Ahri', win: true }),
  d2: playerScore({ composite: 38.4, role: 'JUNGLE', champion: 'Ivern', win: true })
};
const enemy = [
  { role: 'TOP', champion: 'Renekton', composite: 54 },
  { role: 'JUNGLE', champion: 'Viego', composite: 61 }
];

db.saveGame('OLD', { ...gameRecord({ matchId: 'OLD', playedAt: 1000, scores }), queueId: 420 });
db.saveGame('NEW', { ...gameRecord({ matchId: 'NEW', playedAt: 2000, scores }), queueId: 420, enemy });

/** Captures whatever the command replies with. */
function fakeInteraction({ game = null, summary = null } = {}) {
  const captured = {};
  return {
    captured,
    options: {
      getString: () => game,
      getBoolean: () => summary
    },
    async reply(payload) {
      captured.payload = payload;
    }
  };
}

test('defaults to the most recently played game', async () => {
  const i = fakeInteraction();
  await cmd.execute(i);
  assert.match(i.captured.payload.embeds[0].toJSON().footer.text, /Match NEW/);
});

test('opens a specific older game by id', async () => {
  const i = fakeInteraction({ game: 'OLD' });
  await cmd.execute(i);
  assert.match(i.captured.payload.embeds[0].toJSON().footer.text, /Match OLD/);
});

test('shows the full per-role breakdown by default', async () => {
  const i = fakeInteraction();
  await cmd.execute(i);
  const j = i.captured.payload.embeds[0].toJSON();
  // A breakdown field per player, on top of the summary cards.
  assert.ok(j.fields.some((f) => f.name.includes('One') && f.value.includes('Lane')));
  assert.ok(j.fields.some((f) => f.name.includes('Two')));
});

test('summary:true falls back to the short scorecard', async () => {
  const full = fakeInteraction();
  await cmd.execute(full);
  const short = fakeInteraction({ summary: true });
  await cmd.execute(short);

  const fullFields = full.captured.payload.embeds[0].toJSON().fields.length;
  const shortFields = short.captured.payload.embeds[0].toJSON().fields.length;
  assert.ok(shortFields < fullFields, 'summary drops the per-player breakdowns');
});

test('renders the stored enemy line without any API call', async () => {
  const i = fakeInteraction({ game: 'NEW' });
  await cmd.execute(i);
  const j = i.captured.payload.embeds[0].toJSON();
  const enemyField = j.fields.find((f) => f.name.includes('Enemy team'));
  assert.ok(enemyField);
  assert.match(enemyField.value, /Renekton/);
  assert.match(enemyField.value, /Viego/);
});

test('games stored before the enemy line existed still render', async () => {
  const i = fakeInteraction({ game: 'OLD' });
  await cmd.execute(i);
  const j = i.captured.payload.embeds[0].toJSON();
  assert.ok(!j.fields.some((f) => f.name.includes('Enemy team')), 'the section is omitted, not broken');
  assert.ok(j.fields.length > 0, 'the rest of the scorecard is intact');
});

test('rejects an unknown match id instead of throwing', async () => {
  const i = fakeInteraction({ game: 'NOPE' });
  await cmd.execute(i);
  assert.match(i.captured.payload.content, /No stored game/);
});

test('autocomplete lists recent games newest first, within Discord’s limit', async () => {
  let responded = null;
  await cmd.autocomplete({
    options: { getFocused: () => '' },
    async respond(choices) {
      responded = choices;
    }
  });

  assert.equal(responded[0].value, 'NEW', 'newest first');
  assert.ok(responded.length <= 25);
  for (const c of responded) assert.ok(c.name.length <= 100, 'choice labels have a 100 char limit');
  assert.match(responded[0].name, /One Ahri/);
});

test('autocomplete filters on what has been typed', async () => {
  let responded = null;
  await cmd.autocomplete({
    options: { getFocused: () => 'ivern' },
    async respond(choices) {
      responded = choices;
    }
  });
  assert.ok(responded.length > 0);
  for (const c of responded) assert.match(c.name.toLowerCase(), /ivern/);
});
