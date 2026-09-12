// Properties the model must have regardless of what the numbers say (§11.6,
// §11.7, §11.2).
//
// The rest of the suite pins behaviour: this game scores that way, this exploit
// does not pay. These are different — they are statements that must hold for
// *every* input, and each one is a class of bug that produces plausible-looking
// scores rather than errors. A side bias would mean blue side quietly scores
// better than red; a determinism failure would mean the same game scores
// differently on a restart and nobody could tell which run was right.
import test from 'node:test';
import assert from 'node:assert/strict';
import { campedTopScenario, plainMatch } from './helpers/matchFixture.js';
import { scoreMatch } from '../src/scoring/index.js';

const scenario = () => campedTopScenario({ durationMinutes: 32 });
const compositesOf = (scored) =>
  Object.fromEntries(Object.entries(scored).map(([puuid, s]) => [puuid, s.composite]));

// --- §11.2 determinism -------------------------------------------------------

test('the same game scores identically twice', () => {
  const a = scenario();
  const b = scenario();
  assert.deepEqual(compositesOf(scoreMatch(a.match, { timeline: a.timeline })), compositesOf(scoreMatch(b.match, { timeline: b.timeline })));
});

test('scoring does not mutate what it was given', () => {
  // A scorer that edits its input makes the second run of /rescore disagree with
  // the first, and the archive would then be storing something the model has
  // already changed.
  const { match, timeline } = scenario();
  const matchBefore = JSON.stringify(match);
  const timelineBefore = JSON.stringify(timeline);

  scoreMatch(match, { timeline, trackedPuuids: ['p1', 'p2'] });

  assert.equal(JSON.stringify(match), matchBefore, 'the match came back changed');
  assert.equal(JSON.stringify(timeline), timelineBefore, 'the timeline came back changed');
});

test('participant order does not change anyone’s score', () => {
  // Object and array iteration order is the classic source of a score that
  // drifts between runs for no reason anybody can see.
  const straight = scenario();
  const shuffled = scenario();
  shuffled.match.info.participants.reverse();

  const a = compositesOf(scoreMatch(straight.match, { timeline: straight.timeline }));
  const b = compositesOf(scoreMatch(shuffled.match, { timeline: shuffled.timeline }));
  assert.deepEqual(a, b);
});

// --- §11.6 side bias ---------------------------------------------------------

test('swapping the two teams changes nothing', () => {
  // The single most consequential property here. Every metric is a share of a
  // team total or a comparison to a counterpart, and a bias would mean blue side
  // scores better than red for free — which over a season is a bench decision
  // made by the coin flip at champion select.
  const normal = scenario();
  const mirrored = scenario();

  const flip = (t) => (t === 100 ? 200 : 100);
  // "Consistently" includes the map. Which half of Summoner's Rift belongs to
  // whom is decided by the diagonal x + y = 15000, so flipping team ids without
  // reflecting positions does not swap the sides — it leaves everybody standing
  // in what is now the enemy half, which is a different game rather than a
  // mirrored one. Reflecting across that diagonal maps each base to the other
  // and leaves lane assignments alone, which is exactly what a side swap is.
  const reflect = (pos) => (pos ? { x: 15000 - pos.y, y: 15000 - pos.x } : pos);

  for (const p of mirrored.match.info.participants) {
    p.teamId = flip(p.teamId);
    p.win = !p.win;
  }
  for (const frame of mirrored.timeline.info.frames) {
    for (const pf of Object.values(frame.participantFrames)) {
      if (pf.position) pf.position = reflect(pf.position);
    }
    for (const e of frame.events) {
      if (e.killerTeamId != null) e.killerTeamId = flip(e.killerTeamId);
      if (e.teamId != null) e.teamId = flip(e.teamId);
      if (e.position) e.position = reflect(e.position);
    }
  }

  const a = compositesOf(scoreMatch(normal.match, { timeline: normal.timeline }));
  const b = compositesOf(scoreMatch(mirrored.match, { timeline: mirrored.timeline }));

  for (const puuid of Object.keys(a)) {
    assert.ok(
      Math.abs(a[puuid] - b[puuid]) < 0.05,
      `${puuid} scores ${a[puuid]} on one side and ${b[puuid]} on the other`
    );
  }
});

// --- §11.6 monotonicity ------------------------------------------------------

/** Scores the fixture with one participant adjusted, and returns that player. */
function tweaked(participantId, mutate) {
  const s = scenario();
  mutate(
    s.match.info.participants.find((p) => p.participantId === participantId),
    s
  );
  return scoreMatch(s.match, { timeline: s.timeline })[`p${participantId}`];
}

test('more CS at 14 never lowers the score', () => {
  const before = tweaked(3, () => {}).composite;
  const after = tweaked(3, (me, s) => {
    for (const frame of s.timeline.info.frames) {
      const pf = frame.participantFrames[String(me.participantId)];
      if (pf) {
        pf.minionsKilled += 20;
        pf.totalGold += 20 * 20;
      }
    }
    me.totalMinionsKilled += 20;
    me.goldEarned += 400;
  }).composite;

  assert.ok(after >= before - 0.01, `20 more CS should not cost points (${before} -> ${after})`);
});

test('an extra death you caused lowers the score', () => {
  const before = tweaked(3, () => {}).composite;
  const after = tweaked(3, (me, s) => {
    me.deaths += 1;
    // Alone, deep in the enemy half, which is the least excusable kind.
    s.timeline.info.frames[22].events.push({
      type: 'CHAMPION_KILL',
      timestamp: 22 * 60000 + 5000,
      victimId: me.participantId,
      killerId: 8,
      assistingParticipantIds: [],
      position: { x: 11800, y: 11200 }
    });
  }).composite;

  assert.ok(after < before, `an extra solo death should cost points (${before} -> ${after})`);
});

test('a counterpart who does nothing does not hand you a perfect score', () => {
  // The AFK guard. With every opposing stat at zero the head-to-head half is
  // meaningless, and a model anchored only on the counterpart would return
  // something near 100 for an ordinary game.
  const s = scenario();
  const opp = s.match.info.participants.find((p) => p.participantId === 8); // enemy mid
  opp.kills = 0;
  opp.deaths = 0;
  opp.assists = 0;
  opp.totalDamageDealtToChampions = 0;
  opp.goldEarned = 500;
  opp.totalMinionsKilled = 0;
  opp.visionScore = 0;
  opp.damageDealtToTurrets = 0;
  opp.challenges = { ...opp.challenges, teamDamagePercentage: 0, killParticipation: 0, damagePerMinute: 0 };
  for (const frame of s.timeline.info.frames) {
    const pf = frame.participantFrames['8'];
    if (pf) {
      pf.totalGold = 500;
      pf.xp = 0;
      pf.minionsKilled = 0;
    }
  }

  const mid = scoreMatch(s.match, { timeline: s.timeline }).p3;
  assert.ok(mid.composite <= 75, `an AFK counterpart must not produce a ${mid.composite}`);
});

// --- §11.6 graceful degradation ---------------------------------------------

test('a match with no challenges block still scores, and not wildly differently', () => {
  const full = scenario();
  const bare = scenario();
  for (const p of bare.match.info.participants) delete p.challenges;

  const a = scoreMatch(full.match, { timeline: full.timeline });
  const b = scoreMatch(bare.match, { timeline: bare.timeline });

  for (const puuid of Object.keys(a)) {
    assert.ok(Number.isFinite(b[puuid].composite), `${puuid} did not score without challenges`);
    assert.ok(
      Math.abs(a[puuid].composite - b[puuid].composite) < 8,
      `${puuid} moved ${(b[puuid].composite - a[puuid].composite).toFixed(1)} points without the challenges block`
    );
  }
});

test('no timeline degrades to partial rather than failing', () => {
  const { match } = scenario();
  const scored = scoreMatch(match, { timeline: null });
  for (const s of Object.values(scored)) {
    assert.equal(s.dataQuality, 'partial');
    assert.ok(Number.isFinite(s.composite));
  }
});

// --- §11.7 anti-inflation ----------------------------------------------------

/** A one-sided game: team 200 wins every axis by a mile. */
function stomp({ durationMinutes = 24 } = {}) {
  const match = plainMatch({ durationSeconds: durationMinutes * 60 });
  const mins = durationMinutes;
  for (const p of match.info.participants) {
    const winning = p.teamId === 200;
    p.win = winning;
    p.kills = winning ? 8 : 1;
    p.deaths = winning ? 1 : 8;
    p.assists = winning ? 10 : 2;
    p.goldEarned = Math.round((winning ? 620 : 300) * mins);
    p.totalMinionsKilled = Math.round((winning ? 8.5 : 4.5) * mins);
    p.totalDamageDealtToChampions = Math.round((winning ? 900 : 380) * mins);
    p.damageDealtToTurrets = winning ? 6000 : 300;
    p.visionScore = Math.round((winning ? 1.4 : 0.7) * mins);
    p.challenges = {
      ...p.challenges,
      killParticipation: winning ? 0.72 : 0.38,
      // Shares still sum to 1 within each team — a stomp does not change that.
      teamDamagePercentage: 0.2,
      damageTakenOnTeamPercentage: 0.2,
      damagePerMinute: winning ? 900 : 380
    };
  }
  return match;
}

test('not everyone on the winning team of a stomp is excellent', () => {
  // The direct test of whether F4 conditioning works. If a stomp makes all five
  // winners score above 65, the model is measuring the scoreboard rather than
  // the players, and /worst benches whoever was on the wrong side of it.
  const scored = scoreMatch(stomp(), { timeline: null });
  const winners = Object.values(scored).filter((s) => s.win);
  assert.equal(winners.length, 5);
  assert.ok(
    !winners.every((s) => s.composite > 65),
    `every winner scored above 65 (${winners.map((s) => s.composite).join(', ')})`
  );
});

test('not everyone on the losing team of a stomp is a liability', () => {
  const scored = scoreMatch(stomp(), { timeline: null });
  const losers = Object.values(scored).filter((s) => !s.win);
  assert.equal(losers.length, 5);
  assert.ok(
    !losers.every((s) => s.composite < 35),
    `every loser scored below 35 (${losers.map((s) => s.composite).join(', ')})`
  );
});

test('a stomp does not push the whole lobby to the extremes', () => {
  // Somebody on the losing side played their role adequately, and the score
  // should be able to say so. This is what separates "your team lost" from
  // "you played badly".
  const scored = Object.values(scoreMatch(stomp(), { timeline: null }));
  const spread = Math.max(...scored.map((s) => s.composite)) - Math.min(...scored.map((s) => s.composite));
  assert.ok(spread < 55, `a stomp spread the lobby ${spread.toFixed(1)} points apart`);
});

// --- §11.6 length invariance -------------------------------------------------

test('the same performance scores the same at 24 and 40 minutes', () => {
  // Rates held constant, clock changed. Anything measured as a total rather than
  // a rate shows up here as a score that drifts with the length of the game.
  const at = (mins) => {
    const match = plainMatch({ durationSeconds: mins * 60 });
    for (const p of match.info.participants) {
      const scale = mins / 30;
      p.goldEarned = Math.round(450 * mins);
      p.totalMinionsKilled = Math.round(7 * mins);
      p.totalDamageDealtToChampions = Math.round(600 * mins);
      p.visionScore = Math.round(1.1 * mins);
      p.damageDealtToTurrets = Math.round(180 * mins);
      p.kills = Math.round(5 * scale);
      p.deaths = Math.round(4 * scale);
      p.assists = Math.round(7 * scale);
      p.timeCCingOthers = Math.round(1.5 * mins);
      p.challenges = { ...p.challenges, damagePerMinute: 600, visionScorePerMinute: 1.1 };
    }
    return scoreMatch(match, { timeline: null });
  };

  const short = at(24);
  const long = at(40);
  for (const puuid of Object.keys(short)) {
    const drift = Math.abs(long[puuid].composite - short[puuid].composite);
    assert.ok(drift < 6, `${puuid} (${short[puuid].role}) drifts ${drift.toFixed(1)} points with the clock`);
  }
});

// --- §12.1 lobby integrity ---------------------------------------------------

test('an ordinary game is not mistaken for one somebody left', () => {
  // A missing field is not a zero. Treating an absent `timePlayed` as "played no
  // seconds" marked every player in every payload without it as having left,
  // which reads as a lobby nobody turned up to — and since a broken lobby cannot
  // decide a bench, that would have quietly excluded every game from /worst.
  const { match, timeline } = scenario();
  const scored = scoreMatch(match, { timeline });
  for (const s of Object.values(scored)) {
    assert.equal(s.lobbyIntact, true, 'a normal fixture must read as a full lobby');
    assert.equal(s.earlySurrender, false);
  }
});

test('one player leaving marks the whole lobby, not just their counterpart', () => {
  // Their four team-mates now split a team total between four rather than five,
  // so every share on that side inflates, and the other five get a free lane.
  // All ten numbers are measuring the absence.
  const { match, timeline } = scenario();
  for (const p of match.info.participants) p.timePlayed = match.info.gameDuration;
  match.info.participants[7].timePlayed = 400; // left after six minutes

  const scored = scoreMatch(match, { timeline });
  assert.equal(Object.keys(scored).length, 10);
  for (const s of Object.values(scored)) {
    assert.equal(s.lobbyIntact, false, 'every player in the lobby is affected, not only the one opposite');
  }
});

test('a game Riot called off early is flagged as such', () => {
  const { match, timeline } = scenario();
  for (const p of match.info.participants) {
    p.timePlayed = match.info.gameDuration;
    p.gameEndedInEarlySurrender = true;
  }
  const scored = scoreMatch(match, { timeline });
  for (const s of Object.values(scored)) assert.equal(s.earlySurrender, true);
});

test('a flagged game still scores — it just cannot bench anyone', () => {
  // Scored and posted either way, because people want to see the game. The
  // exclusion belongs at the bench decision, not at the scorecard.
  const { match, timeline } = scenario();
  for (const p of match.info.participants) p.timePlayed = match.info.gameDuration;
  match.info.participants[7].timePlayed = 400;

  const scored = scoreMatch(match, { timeline });
  for (const s of Object.values(scored)) assert.ok(Number.isFinite(s.composite));
});
