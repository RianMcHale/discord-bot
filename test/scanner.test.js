// The scan is where Riot API budget is spent, so these tests are mostly about
// what it *doesn't* fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers/tempDb.js';
import { campedTopScenario, plainMatch } from './helpers/matchFixture.js';

useTempDb();
const { db } = await import('../src/storage.js');
const { scanForNewGames } = await import('../src/scanner.js');

// Two of the fixture's ten participants are our squad.
db.upsertPlayer({ discordId: 'd1', riotGameName: 'One', riotTagLine: 'EUW', puuid: 'p1' });
db.upsertPlayer({ discordId: 'd2', riotGameName: 'Two', riotTagLine: 'EUW', puuid: 'p2' });

/** A Riot client that serves canned matches and counts every call. */
function fakeApi({ ids, matches, timelines = {}, failOn = [], staleFor = [], accounts = {}, historyStatus = null }) {
  const calls = { getRecentMatchIds: [], getMatch: [], getTimeline: [], getAccountByRiotId: [] };
  return {
    calls,
    async getRecentMatchIds(puuid) {
      calls.getRecentMatchIds.push(puuid);
      if (historyStatus) throw Object.assign(new Error('nope'), { response: { status: historyStatus } });
      // Simulates a PUUID issued under a previous development key.
      if (staleFor.includes(puuid)) {
        throw Object.assign(new Error(`Exception decrypting ${puuid}`), { response: { status: 400 } });
      }
      return ids;
    },
    async getAccountByRiotId(gameName, tagLine) {
      calls.getAccountByRiotId.push(`${gameName}#${tagLine}`);
      return accounts[gameName] ?? null;
    },
    async getMatch(id) {
      calls.getMatch.push(id);
      if (failOn.includes(id)) throw Object.assign(new Error('boom'), { response: { status: 500 } });
      return matches[id];
    },
    async getTimeline(id) {
      calls.getTimeline.push(id);
      return timelines[id] ?? null;
    }
  };
}

/** A shared match at a given end time, with unique participant puuids per id. */
function sharedMatch(matchId, endTimestamp) {
  const { match } = campedTopScenario();
  match.metadata.matchId = matchId;
  match.info.gameEndTimestamp = endTimestamp;
  return match;
}

/** A match nobody on the squad played — the case that used to be re-fetched forever. */
function foreignMatch(matchId) {
  const match = plainMatch();
  match.metadata.matchId = matchId;
  match.info.participants.forEach((p, i) => (p.puuid = `stranger${i}`));
  return match;
}

test('takes the most recent unscored game by default', async () => {
  db.resetGames();
  const matches = { A: sharedMatch('A', 3000), B: sharedMatch('B', 1000), C: sharedMatch('C', 2000) };
  const api = fakeApi({ ids: ['A', 'B', 'C'], matches });

  // What /fetchgame does: the game you just played is the one you asked about.
  const result = await scanForNewGames({ api, maxToScore: 1 });

  assert.deepEqual(result.scored.map((s) => s.matchId), ['A'], 'newest, not first discovered');
  assert.equal(result.remaining, 2);
  assert.equal(db.allGames().length, 1, 'the rest stay unscored for a later run');
});

test('drains a backlog oldest first when asked', async () => {
  db.resetGames();
  const matches = { A: sharedMatch('A', 3000), B: sharedMatch('B', 1000), C: sharedMatch('C', 2000) };
  const api = fakeApi({ ids: ['A', 'B', 'C'], matches });

  // What the watcher does: separate messages, so they should read in play order.
  const result = await scanForNewGames({ api, maxToScore: 5, order: 'oldest' });

  assert.deepEqual(result.scored.map((s) => s.matchId), ['B', 'C', 'A']);
  assert.equal(result.remaining, 0);
});

test('caps a large backlog and reports what is left', async () => {
  db.resetGames();
  const matches = Object.fromEntries(['A', 'B', 'C', 'D'].map((id, i) => [id, sharedMatch(id, 1000 + i)]));
  const api = fakeApi({ ids: ['A', 'B', 'C', 'D'], matches });

  const result = await scanForNewGames({ api, maxToScore: 2 });

  assert.equal(result.scored.length, 2);
  assert.equal(result.remaining, 2);
  // The cap limits *scoring* work: timelines are only pulled for what gets scored.
  assert.equal(api.calls.getTimeline.length, 2);
});

test('never re-fetches a match with too few tracked players', async () => {
  db.resetGames();
  const matches = { SOLO: foreignMatch('SOLO'), SHARED: sharedMatch('SHARED', 5000) };

  const first = fakeApi({ ids: ['SOLO', 'SHARED'], matches });
  await scanForNewGames({ api: first });
  assert.ok(first.calls.getMatch.includes('SOLO'), 'checked once');

  // This is the fix: a second scan must not spend a request on SOLO again.
  const second = fakeApi({ ids: ['SOLO', 'SHARED'], matches });
  const result = await scanForNewGames({ api: second });

  assert.equal(second.calls.getMatch.length, 0, 'nothing needed re-fetching');
  assert.equal(result.cached, 2, 'one already scored, one already rejected');
  assert.equal(result.scored.length, 0);
});

test('re-checks rejected matches after someone new registers', async () => {
  db.resetGames();
  const matches = { SOLO: foreignMatch('SOLO') };
  await scanForNewGames({ api: fakeApi({ ids: ['SOLO'], matches }) });

  // Deliberately a puuid that appears in no fixture match, so this only changes
  // the roster count and leaves every other test's expectations intact.
  db.upsertPlayer({ discordId: 'd3', riotGameName: 'Three', riotTagLine: 'EUW', puuid: 'never-plays' });

  const after = fakeApi({ ids: ['SOLO'], matches });
  await scanForNewGames({ api: after });
  assert.deepEqual(after.calls.getMatch, ['SOLO'], 'a bigger roster may change the verdict');

  db.resetGames();
});

test('a transient fetch failure is retried rather than cached as a rejection', async () => {
  db.resetGames();
  const matches = { FLAKY: sharedMatch('FLAKY', 9000) };

  const failing = fakeApi({ ids: ['FLAKY'], matches, failOn: ['FLAKY'] });
  const first = await scanForNewGames({ api: failing });
  assert.equal(first.scored.length, 0);

  const recovered = fakeApi({ ids: ['FLAKY'], matches });
  const second = await scanForNewGames({ api: recovered });
  assert.deepEqual(recovered.calls.getMatch, ['FLAKY'], 'a 500 must not permanently hide a real game');
  assert.equal(second.scored.length, 1);
});

test('an unscorable match is rejected permanently', async () => {
  db.resetGames();
  const remake = sharedMatch('REMAKE', 4000);
  remake.info.gameDuration = 240; // scoreMatch throws on anything this short

  const first = fakeApi({ ids: ['REMAKE'], matches: { REMAKE: remake } });
  const result = await scanForNewGames({ api: first });
  assert.equal(result.scored.length, 0);

  const second = fakeApi({ ids: ['REMAKE'], matches: { REMAKE: remake } });
  await scanForNewGames({ api: second });
  assert.equal(second.calls.getMatch.length, 0, 'a remake is unscorable forever, so stop asking');
});

test('scored games carry the squad scores and the timeline flag', async () => {
  db.resetGames();
  const { timeline } = campedTopScenario();
  const api = fakeApi({ ids: ['X'], matches: { X: sharedMatch('X', 7000) }, timelines: { X: timeline } });

  const [game] = (await scanForNewGames({ api })).scored;

  assert.equal(game.hasTimeline, true);
  assert.deepEqual(Object.keys(game.scoresByDiscordId).sort(), ['d1', 'd2']);
  assert.equal(Object.keys(game.scores).length, 10, 'the enemy team is scored too, for context');
  assert.equal(db.allGames()[0].dataQuality, 'full');
});

test('rejects ARAM and never fetches it again', async () => {
  db.resetGames();
  const aram = sharedMatch('ARAM1', 6000);
  Object.assign(aram.info, { queueId: 450, mapId: 12, gameMode: 'ARAM' });

  const first = fakeApi({ ids: ['ARAM1'], matches: { ARAM1: aram } });
  const result = await scanForNewGames({ api: first });

  assert.equal(result.scored.length, 0, 'ARAM must not be scored on a Rift rubric');
  assert.equal(db.allGames().length, 0);
  assert.equal(first.calls.getTimeline.length, 0, 'no timeline call wasted on a rejected match');
  assert.ok(Object.keys(result.skippedReasons).some((r) => /Summoner's Rift/.test(r)));

  const second = fakeApi({ ids: ['ARAM1'], matches: { ARAM1: aram } });
  await scanForNewGames({ api: second });
  assert.equal(second.calls.getMatch.length, 0, 'the rejection is cached');
});

test('rejects Arena and rotating modes played on Rift', async () => {
  db.resetGames();
  const arena = sharedMatch('ARENA1', 6100);
  Object.assign(arena.info, { queueId: 1700, mapId: 30, gameMode: 'CHERRY' });
  const urf = sharedMatch('URF1', 6200);
  Object.assign(urf.info, { queueId: 1900, mapId: 11, gameMode: 'URF' });

  const api = fakeApi({ ids: ['ARENA1', 'URF1'], matches: { ARENA1: arena, URF1: urf } });
  const result = await scanForNewGames({ api });

  assert.equal(result.scored.length, 0);
  assert.equal(result.skippedNow, 2);
});

test('rejects a match where the squad was split across both teams', async () => {
  db.resetGames();
  // p1 stays on team 100; p2 is moved to the enemy side.
  const split = sharedMatch('SPLIT', 6300);
  const p2 = split.info.participants.find((p) => p.puuid === 'p2');
  p2.teamId = 200;

  const api = fakeApi({ ids: ['SPLIT'], matches: { SPLIT: split } });
  const result = await scanForNewGames({ api });

  assert.equal(result.scored.length, 0, 'teammates would otherwise be listed under "Enemy team"');
  assert.match(Object.keys(result.skippedReasons).join(' '), /opposing teams/);
});

test('repairs a PUUID that a new API key can no longer decrypt', async () => {
  // Development keys expire every 24h and PUUIDs are scoped to the key that
  // issued them. Account-v1 keeps working, so this failed silently: the bot found
  // zero candidate matches and reported "no new games".
  db.resetGames();

  // Stand in for what a key rotation does: the stored PUUIDs no longer decrypt,
  // while account-v1 still resolves each Riot ID to a working one.
  const roster = db.allPlayers();
  const working = Object.fromEntries(roster.map((p) => [p.riotGameName, { puuid: p.puuid }]));
  const stale = roster.map((p) => `stale-${p.puuid}`);
  roster.forEach((p) => db.upsertPlayer({ discordId: p.discordId, puuid: `stale-${p.puuid}` }));

  const api = fakeApi({
    ids: ['REPAIRED'],
    matches: { REPAIRED: sharedMatch('REPAIRED', 8000) },
    staleFor: stale,
    accounts: working
  });

  const result = await scanForNewGames({ api });

  assert.equal(api.calls.getAccountByRiotId.length, roster.length, 're-resolved every Riot ID');
  assert.equal(result.apiErrors.length, 0, 'a repairable failure is not an error');
  assert.equal(result.scored.length, 1, 'the game is found after the repair');
  // Persisted, so the next scan needs no repair at all.
  assert.deepEqual(
    db.allPlayers().map((p) => p.puuid).sort(),
    roster.map((p) => p.puuid).sort()
  );
});

test('reports API failures instead of pretending there were no games', async () => {
  db.resetGames();
  const api = fakeApi({ ids: [], matches: {}, historyStatus: 403 });

  const result = await scanForNewGames({ api });

  assert.equal(result.scored.length, 0);
  assert.equal(result.apiErrors.length, db.allPlayers().length, 'every player failed');
  assert.equal(result.apiErrors[0].status, 403);
});

test('reports nothing found without claiming it checked nothing', async () => {
  db.resetGames();
  const api = fakeApi({ ids: [], matches: {} });
  const result = await scanForNewGames({ api });

  assert.equal(result.scored.length, 0);
  assert.equal(result.checked, 0);
  assert.equal(result.remaining, 0);
});
