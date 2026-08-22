// /alltime gained an optional period. The default must stay the genuine
// all-time record — a leaderboard that quietly means "recently" is worse than
// no leaderboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, gameRecord, playerScore } from './helpers/tempDb.js';

useTempDb();
const { db } = await import('../src/storage.js');
const { computeCareerStats } = await import('../src/rollingStats.js');
const alltime = await import('../src/commands/alltime.js');

const DAY = 86400000;
const now = Date.now();

// `veteran` played a lot months ago and badly; `current` has played well this week.
db.upsertPlayer({ discordId: 'veteran', riotGameName: 'Veteran', riotTagLine: 'E', puuid: 'p1' });
db.upsertPlayer({ discordId: 'current', riotGameName: 'Current', riotTagLine: 'E', puuid: 'p2' });

let n = 0;
const store = (who, composite, daysAgo) =>
  db.saveGame(`G${n}`, {
    ...gameRecord({
      matchId: `G${n++}`,
      playedAt: now - daysAgo * DAY,
      scores: { [who]: playerScore({ composite, role: 'MIDDLE' }) }
    }),
    queueId: 420
  });

for (let i = 0; i < 6; i++) store('veteran', 40, 90 - i); // ~3 months ago
for (let i = 0; i < 4; i++) store('veteran', 42, 20 - i); // ~3 weeks ago
for (let i = 0; i < 4; i++) store('current', 70, 5 - i); // this week

const run = async (period) => {
  let out = null;
  await alltime.execute({
    options: { getString: () => period },
    async reply(p) {
      out = p;
    }
  });
  return out.embeds[0].toJSON();
};

test('no period means the full record, unchanged', async () => {
  const j = await run(null);
  assert.match(j.title, /All-time standings/);
  assert.match(j.description, /Across all \*\*14\*\* scored games/);
});

test('a period narrows the games counted', () => {
  const all = computeCareerStats(5, { minGames: 3 });
  const month = computeCareerStats(5, { minGames: 3, since: now - 30 * DAY });
  const week = computeCareerStats(5, { minGames: 3, since: now - 7 * DAY });

  assert.equal(all.totalGames, 14);
  assert.equal(month.totalGames, 8, 'the four this week plus the four from three weeks ago');
  assert.equal(week.totalGames, 4);
});

test('the weekly board reflects who actually played this week', async () => {
  const j = await run('week');
  assert.match(j.title, /Last 7 days/);
  assert.match(j.description, /Across \*\*4\*\* games in the last 7 days/);
  // The veteran played nothing this week, so they are absent entirely.
  assert.ok(!j.description.includes('veteran'));
  assert.match(j.description, /<@current>/);
});

test('ratings are recomputed within the period, not sliced from the all-time number', () => {
  const all = computeCareerStats(5, { minGames: 3 });
  const week = computeCareerStats(5, { minGames: 3, since: now - 7 * DAY });

  const allCurrent = all.stats.find((s) => s.discordId === 'current');
  const weekCurrent = week.stats.find((s) => s.discordId === 'current');

  // Same games for this player either way, but the squad average they are
  // weighted against is different, so the rating must differ.
  assert.equal(allCurrent.gamesPlayed, weekCurrent.gamesPlayed);
  assert.notEqual(allCurrent.rating, weekCurrent.rating);
  assert.ok(week.squadMean > all.squadMean, 'a good week lifts the period average');
});

test('a period with no games says so rather than showing an empty board', async () => {
  db.resetGames();
  db.upsertPlayer({ discordId: 'idle', riotGameName: 'Idle', riotTagLine: 'E', puuid: 'p3' });
  store('idle', 55, 200); // long ago

  let out = null;
  await alltime.execute({
    options: { getString: () => 'week' },
    async reply(p) {
      out = p;
    }
  });
  assert.match(out, /No games scored in the last 7 days/);
});

test('the all-time view still works when a period would be empty', async () => {
  const j = await run(null);
  assert.match(j.title, /All-time standings/);
  assert.match(j.description, /Across all \*\*1\*\* scored game\b/);
});
