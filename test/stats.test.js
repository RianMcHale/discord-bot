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
  const { ranked } = computeRollingStats(10);
  assert.deepEqual(ranked.map((s) => s.discordId), ['slumping', 'steady']);
  // Only the last three games: slumping averages 30, steady 60.
  const recent = computeRollingStats(3).ranked;
  assert.equal(recent.find((s) => s.discordId === 'slumping').rollingAverage, 30);
  assert.equal(recent.find((s) => s.discordId === 'steady').rollingAverage, 60);
});

test('the window is each player’s own games, not the squad’s', () => {
  // `benchwarmer` sat out everything so far. Give them two recent games and the
  // established players must still be measured across their own full window.
  db.saveGame('B1', gameRecord({ matchId: 'B1', playedAt: 7e6, scores: { benchwarmer: playerScore({ composite: 80, role: 'TOP' }) } }));
  db.saveGame('B2', gameRecord({ matchId: 'B2', playedAt: 7e6 + DAY, scores: { benchwarmer: playerScore({ composite: 80, role: 'TOP' }) } }));

  const { ranked, provisional } = computeRollingStats(10, { minGames: 5 });
  const all = [...ranked, ...provisional];

  assert.equal(all.find((s) => s.discordId === 'benchwarmer').gamesPlayed, 2);
  assert.equal(all.find((s) => s.discordId === 'steady').gamesPlayed, 6, 'unaffected by another player’s games');

  db.removeGames(['B1', 'B2']);
});

test('players with no games are excluded rather than ranked last', () => {
  const { ranked, provisional } = computeRollingStats(10);
  const ids = [...ranked, ...provisional].map((s) => s.discordId);
  assert.ok(!ids.includes('benchwarmer'), 'a player who has not played cannot be the worst');
});

test('a minimum splits ranked from provisional without hiding anyone', () => {
  db.saveGame('T1', gameRecord({ matchId: 'T1', playedAt: 6e6, scores: { benchwarmer: playerScore({ composite: 20, role: 'TOP' }) } }));

  const { ranked, provisional, minGames } = computeRollingStats(10, { minGames: 5 });

  assert.equal(minGames, 5);
  assert.deepEqual(ranked.map((s) => s.discordId), ['slumping', 'steady'], 'both have 6 games');
  assert.deepEqual(provisional.map((s) => s.discordId), ['benchwarmer'], 'one game is not enough to rank');
  // Crucially, the worst *ranked* player is not the 20-scoring newcomer.
  assert.equal(ranked[0].discordId, 'slumping', 'a single bad game cannot get someone benched');
  assert.equal(provisional[0].rollingAverage, 20, 'their number is still available to show');

  db.removeGames(['T1']);
});

test('a minimum of 1 ranks everyone who has played', () => {
  const { ranked, provisional } = computeRollingStats(10, { minGames: 1 });
  assert.equal(provisional.length, 0);
  assert.ok(ranked.length >= 2);
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

test('a thin record cannot top the table on a couple of lucky games', () => {
  // The real case: a 2-game player sat first on 61.1 while everyone above 10
  // games was in the 40s. A raw average rewards whoever has played least.
  db.upsertPlayer({ discordId: 'newcomer', riotGameName: 'New', riotTagLine: 'EUW', puuid: 'p4' });
  db.saveGame('N1', gameRecord({ matchId: 'N1', playedAt: 9e6, scores: { newcomer: playerScore({ composite: 70, role: 'TOP' }) } }));
  db.saveGame('N2', gameRecord({ matchId: 'N2', playedAt: 9e6 + DAY, scores: { newcomer: playerScore({ composite: 68, role: 'TOP' }) } }));

  const { stats, squadMean } = computeCareerStats();
  const newcomer = stats.find((s) => s.discordId === 'newcomer');
  const steady = stats.find((s) => s.discordId === 'steady');

  assert.equal(newcomer.average, 69, 'the raw average is untouched');
  assert.ok(newcomer.rating < newcomer.average - 8, 'a 2-game record is pulled hard toward the squad');
  assert.ok(newcomer.rating > squadMean, 'but two good games are still evidence of something');

  // Two good games shouldn't *invert* six decent ones — they genuinely are
  // evidence. What matters is that a nine-point raw gap stops being a landslide.
  const rawGap = newcomer.average - steady.average;
  const ratedGap = newcomer.rating - steady.rating;
  assert.ok(rawGap > 8, `raw gap should be wide (${rawGap})`);
  assert.ok(Math.abs(ratedGap) < 2, `rated gap should be near-level, got ${ratedGap}`);

  db.removeGames(['N1', 'N2']);
});

test('a long record is barely moved by the weighting', () => {
  const steady = computeCareerStats().stats.find((s) => s.discordId === 'steady');
  assert.ok(Math.abs(steady.rating - steady.average) < 6, 'an earned average stays close to raw');
});

test('role ratings are anchored to the player, so one game cannot win a role', () => {
  // steady has 3 games at MIDDLE and 1 at JUNGLE; the single game must not
  // outrank the established one just by being higher.
  db.saveGame('SPIKE', gameRecord({ matchId: 'SPIKE', playedAt: 8e6, scores: { steady: playerScore({ composite: 95, role: 'BOTTOM' }) } }));

  const steady = computeCareerStats().stats.find((s) => s.discordId === 'steady');
  const spike = steady.byRole.find((r) => r.role === 'BOTTOM');
  const mid = steady.byRole.find((r) => r.role === 'MIDDLE');

  assert.equal(spike.average, 95, 'raw is preserved');
  assert.ok(spike.rating < 95, 'a single game is discounted');
  assert.ok(spike.rating < mid.average + 20, 'and cannot run away from their real level');

  db.removeGames(['SPIKE']);
});

test('ranking uses the rating, not the raw average', () => {
  const { stats } = computeCareerStats();
  const ratings = stats.map((s) => s.rating);
  assert.deepEqual(ratings, [...ratings].sort((a, b) => b - a), 'sorted by rating, best first');
});

test('the standings require a minimum record, without hiding anyone', () => {
  db.upsertPlayer({ discordId: 'rookie', riotGameName: 'Rookie', riotTagLine: 'EUW', puuid: 'p9' });
  db.saveGame('R1', gameRecord({ matchId: 'R1', playedAt: 5e6, scores: { rookie: playerScore({ composite: 88, role: 'MIDDLE' }) } }));
  db.saveGame('R2', gameRecord({ matchId: 'R2', playedAt: 5e6 + DAY, scores: { rookie: playerScore({ composite: 84, role: 'MIDDLE' }) } }));

  const { stats, provisional, minGames } = computeCareerStats(5, { minGames: 3 });

  assert.equal(minGames, 3);
  assert.ok(!stats.some((s) => s.discordId === 'rookie'), 'two games does not earn a position');
  const listed = provisional.find((s) => s.discordId === 'rookie');
  assert.ok(listed, 'but they are still returned, not hidden');
  assert.equal(listed.gamesPlayed, 2);
  assert.ok(Number.isFinite(listed.rating), 'with a number to show');

  // And the established players are unaffected.
  assert.ok(stats.some((s) => s.discordId === 'steady'));

  db.removeGames(['R1', 'R2']);
});

test('a minimum of 1 keeps everyone on the board', () => {
  const { stats, provisional } = computeCareerStats(5, { minGames: 1 });
  assert.equal(provisional.length, 0);
  assert.ok(stats.length >= 2);
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
