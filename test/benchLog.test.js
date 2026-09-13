// Recording what /worst said (spec §12.4).
//
// "Log every bench decision with the score, interval, and calibration version —
// so that arguments six weeks later are resolvable." The reason it needs its own
// record is /rescore: the scores a call was built from can be rewritten whenever
// the model improves, so recomputing today cannot say what the bot said then.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers/tempDb.js';

useTempDb();
const { db } = await import('../src/storage.js');
const { benchLogEntry } = await import('../src/benchRating.js');
const worst = await import('../src/commands/worst.js');
const benchlog = await import('../src/commands/benchlog.js');

const DAY = 24 * 60 * 60 * 1000;

function seed(runs) {
  db.resetGames();
  const ids = Object.keys(runs);
  ids.forEach((id, i) => db.upsertPlayer({ discordId: id, riotGameName: id, riotTagLine: 'EUW', puuid: `bl${i}` }));
  const length = Math.max(...ids.map((id) => runs[id].length));
  const now = Date.now();
  for (let g = 0; g < length; g++) {
    const scores = {};
    for (const id of ids) {
      if (runs[id][g] === undefined) continue;
      scores[id] = {
        composite: runs[id][g],
        grade: 'C',
        role: 'BOTTOM',
        champion: 'X',
        kda: '1/1/1',
        win: true,
        dataQuality: 'full',
        roleConfidence: 'HIGH',
        counterpartValid: true,
        lobbyIntact: true,
        earlySurrender: false,
        calibrationVersion: 'test',
        components: [{ key: 'deaths', label: 'Positioning', weight: 20, score: runs[id][g], detail: null }],
        breakdown: {},
        context: {},
        notes: []
      };
    }
    db.saveGame(`B${g}`, { matchId: `B${g}`, playedAt: now - (length - g) * DAY, queueId: 420, durationSeconds: 1800, dataQuality: 'full', scores });
  }
}

const CLEAR = {
  alice: [22, 38, 29, 41, 26, 33, 19, 36],
  bob: [55, 71, 62, 48, 66, 58, 73, 51]
};

const run = async (cmd, { userId = 'bob', player = null } = {}) => {
  let out = null;
  await cmd.execute({
    options: { getUser: () => (player ? { id: player } : null), getString: () => null, getBoolean: () => null },
    user: { id: userId },
    async reply(p) {
      out = p;
    }
  });
  return typeof out === 'string' ? { description: out, fields: [] } : out.embeds[0].toJSON();
};

test('a bench call is recorded with everything needed to explain it later', async () => {
  seed(CLEAR);
  await run(worst, { userId: 'bob' });

  const [entry] = db.benchLog({ limit: 1 });
  assert.ok(entry, 'the call was written down');
  assert.equal(entry.decisive, true);
  assert.equal(entry.named[0].discordId, 'alice');
  assert.ok(Number.isFinite(entry.named[0].rating));
  assert.ok(entry.named[0].low < entry.named[0].rating && entry.named[0].rating < entry.named[0].high, 'with its range');
  assert.equal(entry.by, 'bob', 'and who asked');
  assert.ok('calibrationVersion' in entry, 'and which calibration produced the numbers');
});

test('asking again with nothing changed does not add a second entry', async () => {
  // Otherwise the log records how often people looked, not what the bot said.
  seed(CLEAR);
  await run(worst);
  const before = db.benchLog({ limit: 1000 }).length;
  await run(worst);
  await run(worst);
  const after = db.benchLog({ limit: 1000 });

  assert.equal(after.length, before, 'the same verdict is one entry');
  assert.ok(after[0].timesShown >= 3, 'counted, not repeated');
});

test('a new game makes a new entry', async () => {
  seed(CLEAR);
  await run(worst);
  const before = db.benchLog({ limit: 1000 }).length;

  // One more game moves both ratings, so it is a different verdict on a
  // different basis, even if it names the same person.
  const players = ['alice', 'bob'];
  const scores = Object.fromEntries(
    players.map((id) => [
      id,
      {
        composite: id === 'alice' ? 30 : 60,
        grade: 'C',
        role: 'BOTTOM',
        champion: 'X',
        kda: '1/1/1',
        win: true,
        dataQuality: 'full',
        roleConfidence: 'HIGH',
        counterpartValid: true,
        lobbyIntact: true,
        earlySurrender: false,
        components: [],
        breakdown: {},
        context: {},
        notes: []
      }
    ])
  );
  db.saveGame('NEW', { matchId: 'NEW', playedAt: Date.now(), queueId: 420, durationSeconds: 1800, dataQuality: 'full', scores });
  await run(worst);

  assert.equal(db.benchLog({ limit: 1000 }).length, before + 1);
});

test('a logged call is unchanged by rewriting the scores it came from', async () => {
  // The reason this exists at all. Rescoring moves every number /worst was
  // built from; the record of what it said must not move with them.
  seed(CLEAR);
  await run(worst);
  const [before] = db.benchLog({ limit: 1 });
  const frozen = JSON.parse(JSON.stringify(before));

  // Simulate a /rescore that changes every stored score.
  for (const g of db.allGames()) {
    for (const s of Object.values(g.scores)) s.composite = 50;
    db.saveGame(g.matchId, g);
  }

  const [after] = db.benchLog({ limit: 1 });
  assert.deepEqual(after.named, frozen.named, 'the ratings it quoted are still the ratings it quoted');
  assert.equal(after.decisive, frozen.decisive);
});

test('a tie is recorded as a tie, naming everyone in it', async () => {
  seed({
    alice: [61, 33, 49, 40, 57, 44],
    bob: [38, 64, 45, 59, 36, 55],
    carol: [52, 41, 66, 37, 58, 48]
  });
  await run(worst);
  const [entry] = db.benchLog({ limit: 1 });
  assert.equal(entry.decisive, false);
  assert.ok(entry.named.length >= 2, 'nobody singled out in the record either');
  assert.equal(entry.runnerUp, null);
});

test('the fingerprint separates a call from a tie over the same people', () => {
  const ranked = [
    { discordId: 'a', displayName: 'a', rating: 40, low: 35, high: 45, nEff: 8, gap: [] },
    { discordId: 'b', displayName: 'b', rating: 60, low: 55, high: 65, nEff: 8, gap: [] }
  ];
  const call = benchLogEntry({ decisive: true, worst: ranked[0], tied: [] }, ranked, { calibrationVersion: 'v1' });
  const tie = benchLogEntry({ decisive: false, worst: ranked[0], tied: [ranked[1]] }, ranked, { calibrationVersion: 'v1' });
  const recal = benchLogEntry({ decisive: true, worst: ranked[0], tied: [] }, ranked, { calibrationVersion: 'v2' });

  assert.notEqual(call.fingerprint, tie.fingerprint);
  assert.notEqual(call.fingerprint, recal.fingerprint, 'a recalibration is a different basis for the same call');
});

test('/benchlog shows the calls, and can be filtered to one player', async () => {
  seed(CLEAR);
  await run(worst);

  const all = await run(benchlog);
  assert.match(all.title, /Bench calls/);
  assert.ok(all.fields.length >= 1);
  assert.match(all.fields[0].value, /alice/);

  const bobs = await run(benchlog, { player: 'nobody-ever-named' });
  assert.match(bobs.description, /never named/);
});

test('it says when the model has been recalibrated since a call', async () => {
  // Exactly the case where today's numbers would tell a different story, so it
  // is flagged rather than left for someone to notice.
  seed(CLEAR);
  db.logBenchCall({
    at: Date.now() - 30 * DAY,
    by: 'bob',
    decisive: true,
    named: [{ discordId: 'alice', name: 'alice', rating: 31.2, low: 25.3, high: 37.1, nEff: 8, floor: 19 }],
    runnerUp: null,
    reasons: [],
    calibrationVersion: 'an-old-calibration',
    fingerprint: 'old-call'
  });
  const out = await run(benchlog);
  const old = out.fields.find((f) => /an-old-calibration/.test(f.value));
  assert.ok(old);
  assert.match(old.value, /since recalibrated/);
});

test('record-keeping failing never stops the bench call itself', async () => {
  seed(CLEAR);
  const original = db.logBenchCall;
  db.logBenchCall = () => {
    throw new Error('disk full');
  };
  try {
    const out = await run(worst);
    assert.match(out.title, /Bench recommendation/, 'the squad still gets its answer');
  } finally {
    db.logBenchCall = original;
  }
});
