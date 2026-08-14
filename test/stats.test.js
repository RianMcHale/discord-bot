import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb, gameRecord, playerScore } from './helpers/tempDb.js';

useTempDb();
const { db } = await import('../src/storage.js');
const { computeRollingStats, computeCareerStats } = await import('../src/rollingStats.js');

const DAY = 86400000;

// Two players. `steady` averages 60 across three roles; `slumping` starts strong
// and falls away, and finishes bottom of most games.
db.upsertPlayer({ discordId: 'steady', riotGameName: 'Steady', riotTagLine: 'EUW', puuid: 'p1' });
db.upsertPlayer({ discordId: 'slumping', riotGameName: 'Slumping', riotTagLine: 'EUW', puuid: 'p2' });
db.upsertPlayer({ discordId: 'benchwarmer', riotGameName: 'Bench', riotTagLine: 'EUW', puuid: 'p3' });

const PLAN = [
  { steady: [70, 'MIDDLE', true], slumping: [65, 'JUNGLE', true] },
  { steady: [60, 'MIDDLE', false], slumping: [55, 'JUNGLE', false] },
  { steady: [50, 'TOP', false], slumping: [45, 'JUNGLE', false] },
  { steady: [60, 'TOP', true], slumping: [35, 'BOTTOM', true] },
  { steady: [60, 'MIDDLE', false], slumping: [30, 'BOTTOM', false] },
  { steady: [60, 'JUNGLE', false], slumping: [25, 'BOTTOM', false] }
];
PLAN.forEach((row, i) => {
  const scores = {};
  for (const [id, [composite, role, win]] of Object.entries(row)) {
    scores[id] = playerScore({ composite, role, win, champion: role === 'JUNGLE' ? 'Ivern' : 'Ahri' });
  }
  db.saveGame(`G${i}`, gameRecord({ matchId: `G${i}`, playedAt: 1000 + i * DAY, scores }));
});

test('rolling stats are worst-first and windowed', () => {
  const all = computeRollingStats(10);
  assert.deepEqual(all.map((s) => s.discordId), ['slumping', 'steady']);
  // Only the last three games: slumping averages 30, steady 60.
  const recent = computeRollingStats(3);
  assert.equal(recent.find((s) => s.discordId === 'slumping').rollingAverage, 30);
  assert.equal(recent.find((s) => s.discordId === 'steady').rollingAverage, 60);
});

test('players with no games are excluded rather than ranked last', () => {
  const ids = computeRollingStats(10).map((s) => s.discordId);
  assert.ok(!ids.includes('benchwarmer'), 'a player who has not played cannot be the worst');
});

test('career stats rank by overall average, best first', () => {
  const { stats, totalGames } = computeCareerStats();
  assert.equal(totalGames, 6);
  assert.deepEqual(stats.map((s) => s.discordId), ['steady', 'slumping']);
  assert.equal(stats[0].average, 60);
  assert.equal(stats[0].gamesPlayed, 6);
});

test('per-role averages are split out and cover every game played', () => {
  const steady = computeCareerStats().stats.find((s) => s.discordId === 'steady');
  const total = steady.byRole.reduce((a, r) => a + r.games, 0);
  assert.equal(total, steady.gamesPlayed, 'role counts must add up to games played');
  // Most-played role first.
  assert.equal(steady.byRole[0].role, 'MIDDLE');
  assert.equal(steady.byRole[0].games, 3);
});

test('form compares the recent window against the player’s own average', () => {
  const slumping = computeCareerStats(3).stats.find((s) => s.discordId === 'slumping');
  assert.ok(slumping.formDelta < 0, 'a declining player should show negative form');
  const steady = computeCareerStats(3).stats.find((s) => s.discordId === 'steady');
  assert.ok(Math.abs(steady.formDelta) < 2, 'a consistent player should show flat form');
});

test('form is withheld until there is enough history to compare', () => {
  const stats = computeCareerStats(20).stats; // window larger than any record
  assert.equal(stats[0].form, null);
  assert.equal(stats[0].formDelta, null);
});

test('bench count tracks who finished lowest in each game', () => {
  const { stats } = computeCareerStats();
  const slumping = stats.find((s) => s.discordId === 'slumping');
  assert.equal(slumping.benched, 6, 'lost every head-to-head');
  assert.equal(stats.find((s) => s.discordId === 'steady').benched, 0);
});

test('best and worst games carry their context', () => {
  const steady = computeCareerStats().stats.find((s) => s.discordId === 'steady');
  assert.equal(steady.best, 70);
  assert.equal(steady.bestGame.role, 'MIDDLE');
  assert.equal(steady.bestGame.win, true);
  assert.equal(steady.worst, 50);
});

test('win rate and champion splits are tracked', () => {
  const slumping = computeCareerStats().stats.find((s) => s.discordId === 'slumping');
  assert.equal(slumping.wins, 2);
  assert.equal(slumping.losses, 4);
  assert.equal(slumping.winRate, 33);
  const ivern = slumping.byChampion.find((c) => c.champion === 'Ivern');
  assert.equal(ivern.games, 3);
});

test('history is most-recent-first', () => {
  const steady = computeCareerStats().stats.find((s) => s.discordId === 'steady');
  assert.equal(steady.history[0].matchId, 'G5');
  assert.equal(steady.history.at(-1).matchId, 'G0');
});

test('games stored before the rewrite are counted and flagged', () => {
  db.saveGame('LEGACY', {
    matchId: 'LEGACY',
    playedAt: 500,
    queueId: 420,
    scores: { steady: playerScore({ composite: 55, role: 'TOP' }) }
    // no dataQuality — the marker for the old scoring model
  });
  const { legacyGames } = computeCareerStats();
  assert.equal(legacyGames, 1);
});
