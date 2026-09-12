// /leaderboard and /worst have to agree.
//
// They did not. The leaderboard ranked on a raw mean while /worst ranked on a
// recency-weighted, shrunk rating with an interval, so on the same eight games
// the leaderboard showed one player 8.5 points below another and /worst called
// the same pair indistinguishable. A third player appeared on one and not the
// other, because four games is not four *effective* games once they are a week
// old.
//
// That is finding F6 arriving through a side door, and through the command
// people read most casually.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDb } from './helpers/tempDb.js';

useTempDb();
const { db } = await import('../src/storage.js');
const leaderboard = await import('../src/commands/leaderboard.js');
const worst = await import('../src/commands/worst.js');
const { computeBenchRatings } = await import('../src/benchRating.js');

const DAY = 24 * 60 * 60 * 1000;

function seed(runs) {
  db.resetGames();
  const ids = Object.keys(runs);
  ids.forEach((id, i) => db.upsertPlayer({ discordId: id, riotGameName: id, riotTagLine: 'EUW', puuid: `lp${i}` }));
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
        components: [],
        breakdown: {},
        context: {},
        notes: []
      };
    }
    if (Object.keys(scores).length) {
      db.saveGame(`L${g}`, {
        matchId: `L${g}`,
        playedAt: now - (length - g) * DAY,
        queueId: 420,
        durationSeconds: 1800,
        dataQuality: 'full',
        scores
      });
    }
  }
}

const render = async (cmd) => {
  let out = null;
  await cmd.execute({
    options: { getUser: () => null, getString: () => null, getBoolean: () => null },
    user: { id: 'alice' },
    async reply(p) {
      out = p;
    }
  });
  return typeof out === 'string' ? { description: out, fields: [] } : out.embeds[0].toJSON();
};

const VOLATILE = { alice: [48, 52, 46, 51, 49, 47, 53, 50], bob: [72, 8, 68, 12, 70, 15, 74, 9] };

test('both commands quote the same rating for the same player', async () => {
  seed(VOLATILE);
  const lb = await render(leaderboard);
  const w = await render(worst);
  const rated = computeBenchRatings({ window: 10 }).ranked;

  for (const p of rated) {
    assert.match(lb.description, new RegExp(String(p.rating)), `${p.discordId}'s rating is missing from the leaderboard`);
  }
  // And the one /worst is talking about is quoted identically there.
  const bottom = rated[0];
  const everywhere = w.description + (w.fields || []).map((f) => f.value).join(' ');
  assert.match(everywhere, new RegExp(String(bottom.rating)));
});

test('the leaderboard shows a range, not a bare number', async () => {
  seed(VOLATILE);
  const lb = await render(leaderboard);
  assert.match(lb.description, /\[-?[\d.]+ – -?[\d.]+\]/, 'a point estimate with no interval is what F6 is about');
});

test('it says when the ordering is not a real ordering', async () => {
  // Two players whose ranges overlap are not ranked, they are adjacent. Printing
  // them as 1 and 2 implies a gap that the games do not support.
  seed(VOLATILE);
  const lb = await render(leaderboard);
  assert.match(lb.description, /cannot be told apart|not a real ordering/);
});

test('both commands agree on who is eligible', async () => {
  // carol has four games, but they are a week old — four games is not four
  // effective games. She used to appear on one command and not the other.
  seed({ ...VOLATILE, carol: [55, 58, 52, 60] });
  const lb = await render(leaderboard);
  const w = await render(worst);

  const provisionalIn = (j) => (j.fields || []).find((f) => /Not e(nough|ligible)/.test(f.name))?.value ?? '';
  assert.match(provisionalIn(lb), /carol/, 'carol is short of effective games on the leaderboard');
  assert.match(provisionalIn(w), /carol/, 'and on /worst too');
});

test('an effective-games figure never claims a threshold it has not reached', async () => {
  // 3.995 rounds to 4.0, which then sits beside "4 effective games needed"
  // looking like it qualifies. Flooring means a displayed figure is always at
  // most the real one.
  seed({ ...VOLATILE, carol: [55, 58, 52, 60] });
  const { provisional, minEffectiveGames } = computeBenchRatings({ window: 10 });
  for (const p of provisional) {
    assert.ok(
      p.nEff < minEffectiveGames,
      `${p.discordId} is listed as ineligible while displaying ${p.nEff} of ${minEffectiveGames}`
    );
  }
});

test('a clear gap is still shown as a clear gap', async () => {
  // The fix must not flatten everything into "cannot be told apart".
  seed({
    alice: [22, 38, 29, 41, 26, 33, 19, 36],
    bob: [72, 78, 68, 81, 74, 76, 70, 79]
  });
  const lb = await render(leaderboard);
  assert.doesNotMatch(lb.description, /cannot be told apart/);
});

test('the window is each player’s own games, not the squad’s', () => {
  // Somebody who sat out three of the squad's last ten is still measured across
  // ten of their own, so nobody is judged on a shorter record than everybody
  // else. Ported here from the old rolling-stats path, which this replaced —
  // the property has to survive the implementation that carried it.
  seed({
    regular: [50, 52, 48, 51, 49, 47, 53, 46],
    sporadic: [60, 58] // only played the last two
  });

  const { ranked, provisional } = computeBenchRatings({ window: 10 });
  const all = [...ranked, ...provisional];
  assert.equal(all.find((s) => s.discordId === 'regular').gamesPlayed, 8);
  assert.equal(
    all.find((s) => s.discordId === 'sporadic').gamesPlayed,
    2,
    'and is not padded out with games they did not play'
  );
});
