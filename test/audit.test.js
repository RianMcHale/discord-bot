// Regression tests for bugs found in the full audit. Each one is a failure that
// was silent: nothing threw, the numbers were just quietly wrong.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useTempDb, gameRecord, playerScore } from './helpers/tempDb.js';
import { campedTopScenario, plainMatch } from './helpers/matchFixture.js';

useTempDb();
const { db, dbPath } = await import('../src/storage.js');
const { buildContext } = await import('../src/scoring/context.js');
const { scoreMatch } = await import('../src/scoring/index.js');
const { scanForNewGames } = await import('../src/scanner.js');

const TOP_LANE = { x: 1600, y: 9500 };
const BOT_LANE = { x: 10000, y: 2000 };

test('a kill across the map does not count as a trade', () => {
  // Six solo deaths in top lane. Adding unrelated kills in bot lane, inside the
  // 12s window, used to discount every one of them by 40% — so in a high-kill
  // game death discipline stopped separating anyone.
  const weightedDeaths = (withDistantKills) => {
    const s = campedTopScenario({ durationMinutes: 30 });
    s.timeline.info.frames.forEach((f) => (f.events = []));
    for (const m of [6, 10, 14, 18, 22, 26]) {
      s.timeline.info.frames[m].events.push({
        timestamp: m * 60000, type: 'CHAMPION_KILL', killerId: 6, victimId: 1,
        assistingParticipantIds: [], position: TOP_LANE
      });
      if (withDistantKills) {
        s.timeline.info.frames[m].events.push({
          timestamp: m * 60000 + 3000, type: 'CHAMPION_KILL', killerId: 3, victimId: 8,
          assistingParticipantIds: [], position: BOT_LANE
        });
      }
    }
    const ctx = buildContext(s.match, s.timeline);
    const top = ctx.players.find((p) => p.participantId === 1);
    return { weighted: top.weightedDeathsPerMin * ctx.minutes, tags: top.deathTags };
  };

  const alone = weightedDeaths(false);
  const withNoise = weightedDeaths(true);

  assert.ok(!withNoise.tags.traded, 'a kill in the other lane is not the same fight');
  assert.equal(withNoise.weighted.toFixed(2), alone.weighted.toFixed(2), 'the deaths weigh the same');
});

test('a kill in the same fight still counts as a trade', () => {
  const s = campedTopScenario({ durationMinutes: 30 });
  s.timeline.info.frames.forEach((f) => (f.events = []));
  s.timeline.info.frames[10].events.push({
    timestamp: 600000, type: 'CHAMPION_KILL', killerId: 6, victimId: 1,
    assistingParticipantIds: [], position: TOP_LANE
  });
  s.timeline.info.frames[10].events.push({
    timestamp: 604000, type: 'CHAMPION_KILL', killerId: 3, victimId: 6,
    assistingParticipantIds: [], position: { x: 1800, y: 9700 } // right there
  });
  const ctx = buildContext(s.match, s.timeline);
  assert.equal(ctx.players.find((p) => p.participantId === 1).deathTags.traded, 1);
});

test('a transient timeline failure defers the game instead of storing it degraded', async () => {
  // A game is scored once and never re-scored, so a rate limit during the
  // timeline fetch used to bake permanently degraded scores into history.
  db.resetGames();
  db.upsertPlayer({ discordId: 'a', riotGameName: 'A', riotTagLine: 'E', puuid: 'p1' });
  db.upsertPlayer({ discordId: 'b', riotGameName: 'B', riotTagLine: 'E', puuid: 'p2' });

  const { match, timeline } = campedTopScenario();
  match.metadata.matchId = 'M';
  const api = (failTimeline) => ({
    async getRecentMatchIds() {
      return ['M'];
    },
    async getMatch() {
      return match;
    },
    async getTimeline() {
      return failTimeline
        ? { timeline: null, transientFailure: true, status: 429 }
        : { timeline, transientFailure: false };
    }
  });

  const first = await scanForNewGames({ api: api(true) });
  assert.equal(first.scored.length, 0, 'nothing scored');
  assert.equal(first.deferred, 1);
  assert.equal(first.remaining, 1, 'a deferred game still counts as outstanding');
  assert.equal(db.allGames().length, 0, 'and crucially it is NOT stored');

  const second = await scanForNewGames({ api: api(false) });
  assert.equal(second.scored.length, 1, 'the retry picks it up');
  assert.equal(db.allGames()[0].dataQuality, 'full', 'stored with the full timeline, not partial');
});

test('a genuinely absent timeline is still scored, once', async () => {
  db.resetGames();
  const { match } = campedTopScenario();
  match.metadata.matchId = 'NOTL';
  const api = {
    async getRecentMatchIds() {
      return ['NOTL'];
    },
    async getMatch() {
      return match;
    },
    async getTimeline() {
      return { timeline: null, transientFailure: false }; // Riot said 404
    }
  };
  const result = await scanForNewGames({ api });
  assert.equal(result.scored.length, 1);
  assert.equal(result.deferred, 0);
  assert.equal(db.allGames()[0].dataQuality, 'partial');
  db.resetGames();
});

test('timeline-only fields are initialised, so no rubric reads undefined', () => {
  const ctx = buildContext(plainMatch(), null);
  for (const p of ctx.players) {
    assert.equal(p.roamTakedowns, 0, 'roamTakedowns must not be undefined');
    assert.equal(p.postLaneSwing, null);
    assert.ok(p.teamAvgKp === null || Number.isFinite(p.teamAvgKp));
  }
});

test('a support without a timeline is not given a neutral roam score', () => {
  // roamTakedowns is unknowable without a timeline. Scoring it as 50 would
  // dilute 30% of the support's Participation with a meaningless number.
  const s = campedTopScenario();
  const withTl = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
  const without = scoreMatch(s.match, { timeline: null, trackedPuuids: [] });
  const presence = (scored) => scored.p5.components.find((c) => c.key === 'presence');

  assert.ok(Number.isFinite(presence(without).score));
  assert.ok(!/roam TD/.test(presence(without).detail), 'no roam claim without the data');
  assert.notEqual(presence(without).score, presence(withTl).score);
});

test('an unreadable database is recovered from the last good copy, not wiped', () => {
  // Starting from empty is not a safe fallback. `read()` returning empty is
  // persisted by the very next `write()`, so one bad read destroys the whole
  // history — and every stored game is then re-fetched and re-posted.
  db.resetGames();
  db.upsertPlayer({ discordId: 'x', riotGameName: 'X', riotTagLine: 'E', puuid: 'px' });
  db.saveGame('KEEPME', {
    ...gameRecord({ matchId: 'KEEPME', playedAt: 1, scores: { x: playerScore({ composite: 50, role: 'TOP' }) } }),
    queueId: 420
  });

  fs.writeFileSync(dbPath, '{ "players": { truncated');

  // Used to throw out of every command and every watcher tick.
  assert.doesNotThrow(() => db.allPlayers());
  assert.ok(db.getPlayer('x'), 'the roster survives');
  assert.equal(db.allGames().length, 1, 'and so does the history');
  assert.equal(db.allGames()[0].matchId, 'KEEPME');

  const backups = fs.readdirSync(process.env.DATA_DIR).filter((f) => f.includes('.corrupt-'));
  assert.ok(backups.length >= 1, 'the unreadable file is still preserved for inspection');
});

test('with no usable backup it starts empty rather than refusing to run', () => {
  db.resetGames();
  db.upsertPlayer({ discordId: 'z', riotGameName: 'Z', riotTagLine: 'E', puuid: 'pz' });
  // Both the live file and the recovery point are gone.
  fs.writeFileSync(dbPath, 'not json at all');
  const backup = `${dbPath}.bak`;
  if (fs.existsSync(backup)) fs.writeFileSync(backup, 'also not json');

  assert.doesNotThrow(() => db.allPlayers());
  assert.equal(db.allPlayers().length, 0, 'a bot that runs beats one that will not start');
});

test('writes are atomic, so an interrupted write cannot corrupt the store', () => {
  db.resetGames();
  db.upsertPlayer({ discordId: 'y', riotGameName: 'Y', riotTagLine: 'E', puuid: 'py' });
  db.saveGame('G', { ...gameRecord({ matchId: 'G', playedAt: 1, scores: { y: playerScore({ composite: 50, role: 'TOP' }) } }), queueId: 420 });

  // The temp file must not survive a completed write.
  const leftovers = fs.readdirSync(process.env.DATA_DIR).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no .tmp file left behind');
  assert.equal(db.allGames().length, 1);
});
