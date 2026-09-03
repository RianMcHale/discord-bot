// /benched counts something that already happened rather than ranking form, so
// the rules that protect a leaderboard from thin samples must not apply here:
// hiding someone benched once because they only have two games would hide the
// exact fact being asked for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, gameRecord, playerScore } from './helpers/tempDb.js';

useTempDb();
const { db } = await import('../src/storage.js');
const { computeCareerStats } = await import('../src/rollingStats.js');
const cmd = await import('../src/commands/benched.js');

const DAY = 86400000;
const now = Date.now();
let n = 0;

/** One game. `scores` maps discordId -> [composite, role]. */
function store(scores, daysAgo = 1) {
  const id = `B${n++}`;
  db.saveGame(id, {
    ...gameRecord({
      matchId: id,
      playedAt: now - daysAgo * DAY,
      scores: Object.fromEntries(
        Object.entries(scores).map(([who, [composite, role]]) => [who, playerScore({ composite, role })])
      )
    }),
    queueId: 420
  });
}

function reset() {
  db.resetGames();
  n = 0;
}

for (const [id, name] of [['ana', 'Ana'], ['ben', 'Ben'], ['cai', 'Cai']]) {
  db.upsertPlayer({ discordId: id, riotGameName: name, riotTagLine: 'EUW', puuid: `p_${id}` });
}

const run = async (period = null) => {
  let out = null;
  await cmd.execute({
    options: { getString: () => period },
    async reply(payload) {
      out = payload;
    }
  });
  return typeof out === 'string' ? out : out.embeds[0].toJSON();
};

test('the lowest score in each game is the bench call', async () => {
  reset();
  store({ ana: [70, 'JUNGLE'], ben: [40, 'BOTTOM'] });
  store({ ana: [65, 'JUNGLE'], ben: [30, 'BOTTOM'] });
  store({ ana: [20, 'JUNGLE'], ben: [55, 'BOTTOM'] });

  const { stats } = computeCareerStats(5, { minGames: 1 });
  const by = Object.fromEntries(stats.map((s) => [s.discordId, s]));
  assert.equal(by.ben.benched, 2);
  assert.equal(by.ana.benched, 1);
});

test('roles are tallied by what the benched player was playing', async () => {
  reset();
  store({ ana: [70, 'TOP'], ben: [40, 'JUNGLE'] });
  store({ ana: [70, 'TOP'], ben: [35, 'JUNGLE'] });
  store({ ana: [30, 'TOP'], ben: [60, 'JUNGLE'] });

  const { benchByRole } = computeCareerStats(5, { minGames: 1 });
  const by = Object.fromEntries(benchByRole.map((r) => [r.role, r]));
  assert.equal(by.JUNGLE.benched, 2);
  assert.equal(by.TOP.benched, 1);
  // Games played in the role is the divisor that makes the count mean anything.
  assert.equal(by.JUNGLE.played, 3);
  assert.equal(by.TOP.played, 3);
});

test('a role benched often but played rarely is not the same as one played constantly', async () => {
  reset();
  // Ana plays jungle twice and is benched both times; Ben plays ADC six times
  // and is benched twice. Same count, very different rate.
  for (let i = 0; i < 2; i++) store({ ana: [20, 'JUNGLE'], ben: [60, 'BOTTOM'] });
  for (let i = 0; i < 4; i++) store({ ana: [70, 'TOP'], ben: [30, 'BOTTOM'] });

  const { benchByRole } = computeCareerStats(5, { minGames: 1 });
  const by = Object.fromEntries(benchByRole.map((r) => [r.role, r]));
  assert.equal(by.JUNGLE.benched, 2);
  assert.equal(by.JUNGLE.played, 2, '100% of jungle games');
  assert.equal(by.BOTTOM.benched, 4);
  assert.equal(by.BOTTOM.played, 6, '67% of ADC games');
});

test('a game with only one registered player cannot produce a bench call', async () => {
  reset();
  store({ ana: [10, 'JUNGLE'] }); // alone: worst of one means nothing
  store({ ana: [70, 'JUNGLE'], ben: [40, 'BOTTOM'] });

  const { stats, benchableGames, totalGames } = computeCareerStats(5, { minGames: 1 });
  assert.equal(totalGames, 2);
  assert.equal(benchableGames, 1);
  const ana = stats.find((s) => s.discordId === 'ana');
  assert.equal(ana.benched, 0, 'a 10 played alone is not a bench call');
});

test('the embed leads with roles and then lists people', async () => {
  reset();
  store({ ana: [70, 'TOP'], ben: [40, 'JUNGLE'] });
  store({ ana: [30, 'TOP'], ben: [60, 'JUNGLE'] });

  const j = await run();
  assert.match(j.title, /Bench count/);
  assert.equal(j.fields[0].name, '📍 By role', 'roles were asked for at the top');
  assert.ok(j.fields.some((f) => f.name === '👤 By player'));
  assert.match(j.fields[0].value, /Jungle/);
  assert.match(j.fields[0].value, /Top/);
});

test('someone never benched is still listed, and said to be', async () => {
  reset();
  store({ ana: [70, 'TOP'], ben: [40, 'JUNGLE'] });
  store({ ana: [75, 'TOP'], ben: [45, 'JUNGLE'] });

  const j = await run();
  const people = j.fields.find((f) => f.name === '👤 By player').value;
  assert.match(people, /<@ana>/, 'absence from the list reads as a bug, not as a clean record');
  assert.match(people, /never benched/);
});

test('players below the leaderboard minimum are still counted', async () => {
  reset();
  // Cai has one game. On /alltime they would be provisional and unranked; here
  // that single bench call is the whole point of the command.
  store({ ana: [70, 'TOP'], cai: [20, 'UTILITY'] });

  const j = await run();
  const people = j.fields.find((f) => f.name === '👤 By player').value;
  assert.match(people, /<@cai>/);
  assert.match(j.fields[0].value, /Support/);
});

test('a period narrows the window', async () => {
  reset();
  store({ ana: [70, 'TOP'], ben: [40, 'JUNGLE'] }, 40); // outside 30 days
  store({ ana: [30, 'TOP'], ben: [60, 'JUNGLE'] }, 2); // inside

  const all = await run();
  assert.match(all.description, /\*\*2\*\* bench calls/);

  const week = await run('week');
  assert.match(week.title, /Last 7 days/);
  assert.match(week.description, /\*\*1\*\* bench call/);
  // Jungle was still *played* inside the window, it just wasn't benched in it.
  // Showing the role on 0 is the point: the denominator is what makes a tally
  // mean anything, and "never benched in 8 games" is a real fact.
  assert.match(week.fields[0].value, /\*\*1×\*\* Top/);
  assert.match(week.fields[0].value, /\*\*0×\*\* Jungle/);
});

test('an empty period says so rather than showing a blank board', async () => {
  reset();
  store({ ana: [70, 'TOP'], ben: [40, 'JUNGLE'] }, 200);
  assert.match(await run('week'), /No games scored in the last 7 days/);
});

test('no games at all is handled', async () => {
  reset();
  assert.match(await run(), /No scored games yet/);
});

test('games that were all solo say why there is nothing to show', async () => {
  reset();
  store({ ana: [10, 'JUNGLE'] });
  store({ ana: [20, 'JUNGLE'] });
  const out = await run();
  assert.match(out, /never anyone to be worst \*of\*/);
});

test('the roster fits inside a field, however many have played', async () => {
  reset();
  for (let i = 0; i < 12; i++) {
    db.upsertPlayer({ discordId: `x${i}`, riotGameName: `X${i}`, riotTagLine: 'EUW', puuid: `px${i}` });
  }
  for (let i = 0; i < 12; i++) {
    store({ [`x${i}`]: [20 + i, 'JUNGLE'], ana: [80, 'TOP'] });
  }
  const j = await run();
  for (const f of j.fields) {
    assert.ok(f.value.length <= 1024, `field "${f.name}" is ${f.value.length} chars`);
  }
  // Split across fields rather than truncated: a tally that drops the bottom of
  // the list is worse than one that takes two fields.
  const listed = j.fields.filter((f) => f.value.includes('<@')).flatMap((f) => f.value.match(/<@\w+>/g) ?? []);
  assert.equal(new Set(listed).size, 13, 'everyone who played appears exactly once');
});
