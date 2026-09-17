// Two failings of Gank impact, both about the same blind spot: it could only see
// what a jungler failed to prevent, never what they were doing instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch } from '../src/scoring/index.js';
import { campedTopScenario } from './helpers/matchFixture.js';

const TOP = { x: 1600, y: 9500 };
const BOT = { x: 10000, y: 2000 };
const OWN_JUNGLE = { x: 5200, y: 5200 }; // out of gank range of every lane

/**
 * Our jungler (2) is parked in `mine`; theirs (7) in `theirs`. Both ganks land,
 * one per lane, before laning ends.
 */
function trade({ ourJungleGanks = 0, theirJungleGanks = 0 } = {}) {
  const s = campedTopScenario({ durationMinutes: 32 });

  // Clear the fixture's own ganks so this measures only what we add.
  s.timeline.info.frames.forEach((f) => {
    f.events = f.events.filter((e) => e.type !== 'CHAMPION_KILL');
  });
  // Park each jungler where they are committing, all of laning phase. Ours only
  // goes bot if they are actually committing there — standing in a lane is
  // itself credit by proximity, so "answered nothing" has to mean farming.
  s.timeline.info.frames.forEach((f, m) => {
    if (m > 15) return;
    f.participantFrames['2'].position = ourJungleGanks > 0 ? BOT : OWN_JUNGLE;
    f.participantFrames['7'].position = TOP; // theirs lives top
  });

  const kill = (m, killerId, victimId, assist, position) =>
    s.timeline.info.frames[m].events.push({
      timestamp: m * 60000,
      type: 'CHAMPION_KILL',
      killerId,
      victimId,
      assistingParticipantIds: [assist],
      position
    });

  // Their jungler kills our top laner, with their top laner. Repeatedly.
  for (let i = 0; i < theirJungleGanks; i++) kill(4 + i * 2, 6, 1, 7, TOP);
  // Ours answers in bot: our ADC kills theirs, with our jungler assisting.
  for (let i = 0; i < ourJungleGanks; i++) kill(5 + i * 2, 4, 9, 2, BOT);

  const scored = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
  return { jungler: scored.p2, pressure: scored.p2.components.find((c) => c.key === 'pressure') };
}

test('answering a gank in another lane works off the debt', () => {
  // The most ordinary trade in the game: they commit top, you commit bot.
  // Summing max(0, netPressure) per lane made every lane its own ledger, so the
  // top debt was charged in full and the bot credit vanished.
  const ignored = trade({ theirJungleGanks: 3, ourJungleGanks: 0 });
  const answered = trade({ theirJungleGanks: 3, ourJungleGanks: 3 });

  assert.ok(
    answered.jungler.context.alliesUnanswered < ignored.jungler.context.alliesUnanswered,
    `committing elsewhere has to reduce the debt (${ignored.jungler.context.alliesUnanswered} -> ${answered.jungler.context.alliesUnanswered})`
  );
  assert.ok(
    answered.pressure.score > ignored.pressure.score + 5,
    `and it has to show in the grade (${ignored.pressure.score} -> ${answered.pressure.score})`
  );
});

test('credit offsets at less than face value', () => {
  // Pressure taken is corroborated by deaths in the kill feed; pressure given is
  // largely inferred from position frames. They are not equally trustworthy, so
  // answering must not fully erase what you let happen.
  const answered = trade({ theirJungleGanks: 3, ourJungleGanks: 3 });
  assert.ok(answered.jungler.context.alliesUnanswered > 0, 'an even trade should not wipe the slate clean');
});

test('the detail line shows the credit, not just the debt', () => {
  const answered = trade({ theirJungleGanks: 3, ourJungleGanks: 3 });
  assert.match(answered.pressure.detail, /answered elsewhere/, '"3.3 unanswered" reads as an accusation on its own');
});

test('a jungler who answered nothing is unaffected by the change', () => {
  const ignored = trade({ theirJungleGanks: 3, ourJungleGanks: 0 });
  // Careful: "unanswered" contains "answered". Match the parenthetical itself.
  assert.doesNotMatch(ignored.pressure.detail, /answered elsewhere/);
  assert.ok(ignored.jungler.context.alliesUnanswered > 1, 'the debt still stands in full');
});

// --- your ganks decide it, the debt only reduces it -------------------------
//
// The component is named Gank impact, and it used to be a 55/45 blend of your
// ganks and your response to theirs. A jungler with seven takedowns by 14 could
// score 26, because the response half scored 7 on its own. It is now your ganks
// minus a capped reduction.

/** The `−X.X` the detail line shows when the debt cost points, or 0 if it shows none. */
const penaltyOf = (detail) => {
  const m = detail.match(/−([\d.]+)/);
  return m ? Number(m[1]) : 0;
};

test('your own ganks move the score more than the whole penalty can', () => {
  // The guard against the complaint this rewrite came from. With the enemy
  // jungler held fixed, three takedowns of your own has to be worth more than
  // the entire unanswered reduction is capped at — otherwise the component is
  // still mostly a grade of someone else's game.
  for (const theirs of [0, 3, 6]) {
    const idle = trade({ theirJungleGanks: theirs, ourJungleGanks: 0 });
    const active = trade({ theirJungleGanks: theirs, ourJungleGanks: 3 });
    assert.ok(
      active.pressure.score - idle.pressure.score > 15,
      `against ${theirs} enemy ganks, your own three moved it only ${(active.pressure.score - idle.pressure.score).toFixed(1)}`
    );
  }
});

test('the unanswered debt can only ever subtract', () => {
  // It used to be `versus(theirUnanswered, myUnanswered)`, which *rewarded* you
  // when your lanes were never ganked — a jungler who did nothing all game
  // scored 36 on this for the enemy jungler also doing nothing. One-directional
  // now: it is a reduction or it is absent.
  for (const ours of [0, 3, 6]) {
    for (const theirs of [0, 3, 6]) {
      const r = trade({ theirJungleGanks: theirs, ourJungleGanks: ours });
      assert.doesNotMatch(r.pressure.detail, /\+[\d.]/, 'the debt must never read as a bonus');
      assert.ok(
        penaltyOf(r.pressure.detail) <= 15.001,
        `${ours}v${theirs} took off ${penaltyOf(r.pressure.detail)}, past the cap`
      );
    }
  }
});

test('answering everything costs nothing at all', () => {
  // Not merely "costs less" — a jungler who was where they needed to be should
  // see the reduction disappear, not shrink.
  const r = trade({ theirJungleGanks: 0, ourJungleGanks: 3 });
  assert.equal(r.jungler.context.alliesUnanswered, 0);
  assert.equal(penaltyOf(r.pressure.detail), 0, r.pressure.detail);
});

test('a busier enemy jungler is not charged twice', () => {
  // The old blend put their ganks in both halves: they raised the debt *and*
  // beat you on the head-to-head. The reduction is driven by the share you
  // failed to answer, so their volume now sits in the denominator too — going
  // from three enemy ganks to six must not deepen the cut in proportion.
  const three = trade({ theirJungleGanks: 3, ourJungleGanks: 3 });
  const six = trade({ theirJungleGanks: 6, ourJungleGanks: 3 });
  assert.ok(six.jungler.context.lanesLeftHanging > three.jungler.context.lanesLeftHanging, 'more pressure to answer');
  assert.ok(
    penaltyOf(six.pressure.detail) < penaltyOf(three.pressure.detail) * 2,
    `${penaltyOf(three.pressure.detail)} -> ${penaltyOf(six.pressure.detail)} is the double-count back`
  );
});

test('the detail says what came off, so the number is arguable', () => {
  const r = trade({ theirJungleGanks: 3, ourJungleGanks: 3 });
  assert.match(r.pressure.detail, /^\d+ gank takedowns/, 'your own ganks lead, because they decide it');
  assert.match(r.pressure.detail, /of [\d.]+ lane ganks unanswered/, 'and the debt is shown as a share, not a raw count');
});

// --- post-15 teamfight impact ----------------------------------------------

test('the jungler is graded on the fights after laning, not just damage share', () => {
  const s = campedTopScenario({ durationMinutes: 32 });
  const scored = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
  const combat = scored.p2.components.find((c) => c.key === 'combat');
  assert.match(combat.detail, /post-15/, 'a jungler who vanished after 15 should be seen to have vanished');
});

test('raising the Teamfight weight did not rescue the farming jungler', () => {
  // This is the fixture the whole rewrite exists for: 3/2/9, contests nothing,
  // lets every lane fall behind. Teamfight went 12 -> 15, and the guard is that
  // post-15 participation is the half a farming jungler cannot fake.
  const s = campedTopScenario({ durationMinutes: 32 });
  const scored = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
  assert.ok(scored.p2.composite < 40, `farming jungler scored ${scored.p2.composite}`);
  assert.equal(scored.p2.grade, 'F');
  assert.ok(
    scored.p1.composite > scored.p2.composite,
    'the camped top laner still outranks the jungler who left them there'
  );
});

test('the jungle weights still sum to 100', () => {
  const s = campedTopScenario({ durationMinutes: 27 });
  const scored = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
  assert.equal(scored.p2.components.reduce((t, c) => t + c.weight, 0), 100);
});
