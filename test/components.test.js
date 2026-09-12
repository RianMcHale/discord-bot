// Every scored game stores six component scores per player. Until now nothing
// read them except the single-match card, so "who is worst" could be answered
// but "what are they doing wrong" could not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers/tempDb.js';

useTempDb();
const { db } = await import('../src/storage.js');
const { aggregateComponents, computeCareerStats } = await import('../src/rollingStats.js');
const worst = await import('../src/commands/worst.js');
const profile = await import('../src/commands/profile.js');

const SUP = [['vision', 'Vision', 28], ['utility', 'Utility', 22], ['deaths', 'Deaths', 12]];
const ADC = [['vision', 'Vision', 10], ['utility', 'Utility', 22], ['deaths', 'Positioning', 20]];

function storeGame(matchId, playedAt, entries) {
  const scores = {};
  for (const [id, role, spec, values] of entries) {
    scores[id] = {
      composite: 50, grade: 'C', role, champion: 'X', kda: '1/1/1', win: true,
      components: spec.map(([key, label, weight], i) => ({ key, label, weight, score: values[i], detail: null })),
      breakdown: {}, context: {}, notes: []
    };
  }
  db.saveGame(matchId, { matchId, playedAt, queueId: 420, durationSeconds: 1800, dataQuality: 'full', scores });
}

function seed({ visionRun, id = 'weak', role = 'UTILITY', spec = SUP } = {}) {
  db.resetGames();
  db.upsertPlayer({ discordId: id, riotGameName: 'Weak', riotTagLine: 'E', puuid: 'p1' });
  db.upsertPlayer({ discordId: 'solid', riotGameName: 'Solid', riotTagLine: 'E', puuid: 'p2' });
  visionRun.forEach((v, i) => {
    storeGame(`G${i}`, 1000 + i, [
      [id, role, spec, [v, 62, 55]],
      ['solid', 'BOTTOM', ADC, [58, 60, 57]]
    ]);
  });
}

const reply = async (cmd, opts = {}) => {
  let out = null;
  await cmd.execute({
    options: { getUser: () => ({ id: opts.userId, displayAvatarURL: () => null }), getString: () => null, getBoolean: () => null },
    user: { id: opts.userId },
    async reply(p) {
      out = p;
    }
  });
  return out.embeds[0].toJSON();
};

test('components are averaged by key, worst first', () => {
  seed({ visionRun: [36, 41, 33, 44, 39] });
  const agg = aggregateComponents(db.gamesForPlayer('weak'), 'weak');
  assert.equal(agg[0].key, 'vision', 'the weakest component leads');
  assert.equal(agg[0].average, 38.6);
  assert.equal(agg.at(-1).key, 'utility');
});

test('weak games are counted, not just averaged', () => {
  // An average of 45 could be five 45s or one 20 and four 51s. The count says which.
  seed({ visionRun: [36, 41, 33, 44, 39] });
  const vision = aggregateComponents(db.gamesForPlayer('weak'), 'weak').find((c) => c.key === 'vision');
  assert.equal(vision.weakGames, 5);
  assert.equal(vision.games, 5);
  assert.equal(vision.reliable, true);
});

test('a component needs three games before it counts as a pattern', () => {
  seed({ visionRun: [36, 41] });
  const vision = aggregateComponents(db.gamesForPlayer('weak'), 'weak').find((c) => c.key === 'vision');
  assert.equal(vision.reliable, false, 'two games is not a pattern');
});

test('the label follows whichever role they mostly played', () => {
  // `deaths` is called Positioning for an ADC and Deaths everywhere else.
  db.resetGames();
  db.upsertPlayer({ discordId: 'mixed', riotGameName: 'Mixed', riotTagLine: 'E', puuid: 'p3' });
  storeGame('A', 1, [['mixed', 'UTILITY', SUP, [50, 50, 50]]]);
  storeGame('B', 2, [['mixed', 'BOTTOM', ADC, [50, 50, 50]]]);
  storeGame('C', 3, [['mixed', 'BOTTOM', ADC, [50, 50, 50]]]);

  const deaths = aggregateComponents(db.gamesForPlayer('mixed'), 'mixed').find((c) => c.key === 'deaths');
  assert.equal(deaths.label, 'Positioning', 'two ADC games outvote one support game');
  assert.equal(deaths.games, 3, 'but all three still count toward the average');
});

test('components dropped for missing data are skipped, not counted as zero', () => {
  db.resetGames();
  db.upsertPlayer({ discordId: 'gappy', riotGameName: 'Gappy', riotTagLine: 'E', puuid: 'p4' });
  storeGame('A', 1, [['gappy', 'UTILITY', SUP, [40, 60, 50]]]);
  storeGame('B', 2, [['gappy', 'UTILITY', SUP, [null, 60, 50]]]); // no timeline that game

  const vision = aggregateComponents(db.gamesForPlayer('gappy'), 'gappy').find((c) => c.key === 'vision');
  assert.equal(vision.games, 1, 'only the game that measured it');
  assert.equal(vision.average, 40, 'a null must not drag the average to 20');
});

test('games stored before components existed do not break aggregation', () => {
  db.resetGames();
  db.upsertPlayer({ discordId: 'old', riotGameName: 'Old', riotTagLine: 'E', puuid: 'p5' });
  db.saveGame('LEGACY', {
    matchId: 'LEGACY', playedAt: 1, queueId: 420,
    scores: { old: { composite: 55, role: 'TOP', champion: 'X', kda: '1/1/1', win: true } }
  });
  assert.doesNotThrow(() => aggregateComponents(db.gamesForPlayer('old'), 'old'));
  assert.deepEqual(aggregateComponents(db.gamesForPlayer('old'), 'old'), []);
});

test('recent and career stats both carry the breakdown', async () => {
  // The bench rating replaced the old rolling-stats path, and has to still carry
  // the per-component breakdown — it is what turns "you scored 44" into a claim
  // somebody can argue with.
  const { computeBenchRatings } = await import('../src/benchRating.js');
  seed({ visionRun: [36, 41, 33, 44, 39] });

  const rated = computeBenchRatings({ window: 10 });
  const recent = [...rated.ranked, ...rated.provisional].find((s) => s.discordId === 'weak');
  const career = computeCareerStats().stats.find((s) => s.discordId === 'weak');

  assert.equal(recent.byComponent[0].key, 'vision');
  assert.equal(career.byComponent[0].key, 'vision');
});

test('/worst names the weakness and calls out the pattern', async () => {
  seed({ visionRun: [36, 41, 33, 44, 39, 42, 38] });
  const j = await reply(worst);
  const field = j.fields.find((f) => f.name.includes('Consistently weak'));

  assert.ok(field, 'the bench call explains itself');
  assert.match(field.value, /Vision 3\d/);
  assert.match(field.value, /under 45 in 7 of 7 games/);
  assert.match(field.value, /Fine at:/, 'and says what they are doing well');
});

test('/worst says so when nothing actually stands out', async () => {
  // Lowest of a close group, with no component genuinely broken.
  seed({ visionRun: [49, 51, 48, 50, 49] });
  const j = await reply(worst);
  const field = j.fields.find((f) => f.name.includes('Consistently weak'));
  assert.match(field.value, /Nothing stands out/);
});

test('/profile shows the component breakdown, worst first', async () => {
  seed({ visionRun: [36, 41, 33, 44, 39] });
  const j = await reply(profile, { userId: 'weak' });
  const field = j.fields.find((f) => f.name.includes('By component'));

  assert.ok(field);
  assert.match(field.value, /🔴 \*\*Vision\*\*/, 'a real weakness is flagged red');
  assert.match(field.value, /under 45 in 5\/5/);
  assert.ok(field.value.indexOf('Vision') < field.value.indexOf('Utility'), 'worst first');
});
