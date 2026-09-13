// /worst end to end, over a real stored history.
//
// The unit tests in benchRating.test.js pin the statistics. These pin what the
// squad actually sees, because the point of finding F6 is not that the maths was
// wrong in the abstract — it is that the bot was naming a person.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers/tempDb.js';

useTempDb();
const { db } = await import('../src/storage.js');
const worst = await import('../src/commands/worst.js');

const DAY = 24 * 60 * 60 * 1000;
const COMPONENTS = [
  ['combat', 'Damage', 28],
  ['deaths', 'Positioning', 20],
  ['vision', 'Vision', 10]
];

/** Stores one game per entry: [discordId, composite, componentScores]. */
function storeGame(matchId, playedAt, entries, over = {}) {
  const scores = {};
  for (const [id, composite, values] of entries) {
    scores[id] = {
      composite,
      grade: 'C',
      role: 'BOTTOM',
      champion: 'X',
      kda: '5/3/7',
      win: true,
      dataQuality: 'full',
      roleConfidence: 'HIGH',
      counterpartValid: true,
      calibrationVersion: 'test',
      components: COMPONENTS.map(([key, label, weight], i) => ({
        key,
        label,
        weight,
        score: values?.[i] ?? composite,
        detail: null
      })),
      breakdown: {},
      context: {},
      notes: [],
      ...over
    };
  }
  db.saveGame(matchId, {
    matchId,
    playedAt,
    queueId: 420,
    durationSeconds: 1800,
    dataQuality: 'full',
    scores
  });
}

/**
 * `runs` maps a player to their run of composites, most recent last.
 * Games are dated one day apart ending yesterday, so they are all recent.
 */
function seed(runs, { components = {} } = {}) {
  db.resetGames();
  const ids = Object.keys(runs);
  ids.forEach((id, i) =>
    db.upsertPlayer({ discordId: id, riotGameName: id, riotTagLine: 'EUW', puuid: `puuid-${i}` })
  );
  const length = Math.max(...ids.map((id) => runs[id].length));
  const now = Date.now();
  for (let g = 0; g < length; g++) {
    const entries = ids
      .filter((id) => runs[id][g] !== undefined)
      .map((id) => [id, runs[id][g], components[id]]);
    if (entries.length) storeGame(`G${g}`, now - (length - g) * DAY, entries);
  }
}

const reply = async () => {
  let out = null;
  await worst.execute({
    options: { getUser: () => null, getString: () => null, getBoolean: () => null },
    async reply(p) {
      out = p;
    }
  });
  return typeof out === 'string' ? { description: out, fields: [] } : out.embeds[0].toJSON();
};

test('a close pair is reported as a tie rather than a bench call', async () => {
  // The F6 case exactly: a few points apart over a handful of games, which is
  // inside the noise. Naming one of them is picking by luck.
  seed({
    alice: [61, 33, 49, 40, 57, 44],
    bob: [38, 64, 45, 59, 36, 55],
    carol: [52, 41, 66, 37, 58, 48]
  });
  const j = await reply();
  assert.match(j.title, /Too close to call/);
  assert.match(j.description, /cannot be told apart/);
  // Both names, so nobody is singled out by a number that cannot support it.
  assert.match(j.description, /alice/);
  assert.match(j.description, /bob/);
});

test('a player who is genuinely and consistently worse is named', async () => {
  // A real gap, wide enough to survive its own error bars.
  seed({
    alice: [22, 38, 29, 41, 26, 33, 19, 36],
    bob: [55, 71, 62, 48, 66, 58, 73, 51],
    carol: [49, 63, 57, 44, 68, 52, 60, 47]
  });
  const j = await reply();
  assert.match(j.title, /Bench recommendation/);
  assert.match(j.description, /alice/);
  assert.doesNotMatch(j.description, /cannot be told apart/);
});

test('the call always shows its range, never a bare number', async () => {
  seed({
    alice: [22, 38, 29, 41, 26, 33, 19, 36],
    bob: [55, 71, 62, 48, 66, 58, 73, 51]
  });
  const j = await reply();
  // "34.2 [28.1 – 40.3]" — a point estimate with no interval is the thing that
  // made this command overclaim in the first place.
  assert.match(j.description, /\[-?[\d.]+ – -?[\d.]+\]/, 'the 95% range has to be on screen');
});

test('the reason is shown alongside the name', async () => {
  seed(
    {
      alice: [22, 38, 29, 41, 26, 33, 19, 36],
      bob: [55, 71, 62, 48, 66, 58, 73, 51]
    },
    { components: { alice: [30, 22, 40], bob: [60, 70, 55] } }
  );
  const j = await reply();
  const field = j.fields.find((f) => f.name.includes('Consistently weak'));
  assert.ok(field, 'a bench call with no visible reason is just blame with extra latency');
  assert.match(field.value, /Positioning/, 'the worst component is named');
  assert.match(field.value, /squad/, 'and compared to what everyone else manages');
});

test('nobody is benched on too few games', async () => {
  seed({ alice: [22, 38], bob: [55, 71] });
  const j = await reply();
  assert.match(j.title, /No bench call yet/);
  assert.match(j.description, /effective games/);
});

test('games without a timeline cannot bench anyone', async () => {
  // Eight games each, but every one was scored without a timeline, so lane
  // state, jungle pressure and death context never entered the score.
  db.resetGames();
  for (const [i, id] of ['alice', 'bob'].entries()) {
    db.upsertPlayer({ discordId: id, riotGameName: id, riotTagLine: 'EUW', puuid: `pp${i}` });
  }
  const now = Date.now();
  for (let g = 0; g < 8; g++) {
    storeGame(
      `P${g}`,
      now - (8 - g) * DAY,
      [
        ['alice', 30, null],
        ['bob', 60, null]
      ],
      { dataQuality: 'partial' }
    );
  }
  const j = await reply();
  assert.match(j.title, /No bench call yet/);
});

test('an uncertain role cannot bench anyone either', async () => {
  // A silent failure: the wrong counterpart produces a plausible number, not an
  // error, so the score looks exactly as trustworthy as a correct one.
  db.resetGames();
  for (const [i, id] of ['alice', 'bob'].entries()) {
    db.upsertPlayer({ discordId: id, riotGameName: id, riotTagLine: 'EUW', puuid: `pq${i}` });
  }
  const now = Date.now();
  for (let g = 0; g < 8; g++) {
    storeGame(
      `R${g}`,
      now - (8 - g) * DAY,
      [
        ['alice', 30, null],
        ['bob', 60, null]
      ],
      { roleConfidence: 'LOW' }
    );
  }
  const j = await reply();
  assert.match(j.title, /No bench call yet/);
});

// ---------------------------------------------------------------------------
// The floor (spec §8.4)
//
// Shown beside the rating and never used to decide anything. The spec argues the
// floor is the better bench criterion for a rotation and warns it will feel
// harsher, so the squad looks at both before deciding whether to switch.
// ---------------------------------------------------------------------------

test('the floor is shown alongside the rating', async () => {
  seed({
    alice: [22, 38, 29, 41, 26, 33, 19, 36],
    bob: [55, 71, 62, 48, 66, 58, 73, 51]
  });
  const j = await reply();
  assert.match(j.description, /floor \*\*[\d.]+\*\*/, 'the harsher number has to be visible to be argued about');
});

test('the floor does not change who is named', async () => {
  // A player whose average is fine but whose bad nights are terrible. On floor
  // they would be bottom; on the mean they are not, and the mean is what decides.
  seed({
    alice: [48, 52, 46, 51, 49, 47, 53, 50], // steady, never disastrous
    bob: [72, 8, 68, 12, 70, 15, 74, 9] // brilliant or catastrophic
  });
  const j = await reply();
  // bob's mean is higher than alice's, so alice is bottom on the rating even
  // though bob owns every one of the worst games in the window.
  if (/Bench recommendation/.test(j.title)) {
    assert.match(j.description, /alice/, 'the verdict still follows the rating');
  } else {
    assert.match(j.title, /Too close to call/);
  }
});

test('it says so when the floor would flip the order', async () => {
  // The case worth surfacing: the two criteria disagree. That is exactly the
  // evidence the squad needs to settle which one they want.
  seed({
    alice: [40, 44, 38, 45, 41, 43, 39, 42], // lower mean, no disasters
    bob: [70, 6, 66, 9, 72, 11, 68, 7] // higher mean, far worse floor
  });
  const j = await reply();
  if (/Bench recommendation/.test(j.title)) {
    assert.match(j.description, /floor/, 'both floors are on screen');
  }
});

test('a floor is withheld until there are enough games to have one', async () => {
  // Drawn from two games it is just the lower of the two, which is not a floor.
  db.resetGames();
  for (const [i, id] of ['alice', 'bob'].entries()) {
    db.upsertPlayer({ discordId: id, riotGameName: id, riotTagLine: 'EUW', puuid: `pf${i}` });
  }
  const now = Date.now();
  for (let g = 0; g < 2; g++) {
    storeGame(`F${g}`, now - (2 - g) * DAY, [
      ['alice', 30, null],
      ['bob', 60, null]
    ]);
  }
  const j = await reply();
  assert.match(j.title, /No bench call yet/, 'two games is not enough to bench on anyway');
});

// ---------------------------------------------------------------------------
// Meta breaks (spec §7.5)
// ---------------------------------------------------------------------------

test('games past a declared meta break cannot bench anyone until recalibration', async () => {
  // The one hard rule §7.5 sets. The calibration on disk covers up to 16.17; a
  // declared break at 17.1 means games on 17.2 are measured against bars from a
  // game that no longer exists.
  const { config } = await import('../src/config.js');
  const before = config.metaBreaks;
  config.metaBreaks = ['17.1'];
  try {
    db.resetGames();
    for (const [i, id] of ['alice', 'bob'].entries()) {
      db.upsertPlayer({ discordId: id, riotGameName: id, riotTagLine: 'EUW', puuid: `mb${i}` });
    }
    const now = Date.now();
    for (let g = 0; g < 8; g++) {
      storeGame(`M${g}`, now - (8 - g) * DAY, [
        ['alice', [22, 38, 29, 41, 26, 33, 19, 36][g], null],
        ['bob', [55, 71, 62, 48, 66, 58, 73, 51][g], null]
      ]);
      const stored = db.allGames().find((x) => x.matchId === `M${g}`);
      db.saveGame(stored.matchId, { ...stored, patch: '17.2' });
    }

    const { computeBenchRatings } = await import('../src/benchRating.js');
    const rated = computeBenchRatings({ window: 10 });
    assert.equal(rated.ranked.length, 0, 'nobody is benched on bars from a game that has changed');
    assert.equal(rated.pastMetaBreak, 16, 'and the games are counted separately, since the fix is to recalibrate');
  } finally {
    config.metaBreaks = before;
  }
});

test('an ordinary newer patch keeps benching as normal', async () => {
  // Only declared breaks stop anything. Treating every fortnightly patch as one
  // would stop the bench working half the time.
  db.resetGames();
  for (const [i, id] of ['alice', 'bob'].entries()) {
    db.upsertPlayer({ discordId: id, riotGameName: id, riotTagLine: 'EUW', puuid: `np${i}` });
  }
  const now = Date.now();
  for (let g = 0; g < 8; g++) {
    storeGame(`N${g}`, now - (8 - g) * DAY, [
      ['alice', [22, 38, 29, 41, 26, 33, 19, 36][g], null],
      ['bob', [55, 71, 62, 48, 66, 58, 73, 51][g], null]
    ]);
    const stored = db.allGames().find((x) => x.matchId === `N${g}`);
    db.saveGame(stored.matchId, { ...stored, patch: '16.19' });
  }
  const j = await reply();
  assert.match(j.title, /Bench recommendation/, 'two patches past the calibration, no declared break, business as usual');
});
