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
  assert.match(answered.pressure.detail, /less [\d.]+ answered/, '"3.3 unanswered" reads as an accusation on its own');
});

test('a jungler who answered nothing is unaffected by the change', () => {
  const ignored = trade({ theirJungleGanks: 3, ourJungleGanks: 0 });
  // Careful: "unanswered" contains "answered". Match the parenthetical itself.
  assert.doesNotMatch(ignored.pressure.detail, /less [\d.]+ answered/);
  assert.ok(ignored.jungler.context.alliesUnanswered > 1, 'the debt still stands in full');
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
