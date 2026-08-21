// A Leona who won bot lane, left it to roam, and finished 3/3/13 was scored last
// on her team. Three separate causes, all of them bugs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch } from '../src/scoring/index.js';
import { campedTopScenario } from './helpers/matchFixture.js';

const MID = { x: 7400, y: 7200 };
const BOT = { x: 10400, y: 2400 };

/** The fixture, stripped of its events so a test can supply its own. */
function blank({ durationMinutes = 24 } = {}) {
  const s = campedTopScenario({ durationMinutes });
  s.timeline.info.frames.forEach((f) => (f.events = []));
  return s;
}

const add = (s, minute, ev) => s.timeline.info.frames[minute].events.push({ timestamp: minute * 60000 + 1, ...ev });
const score = (s) => scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
const comp = (scored, puuid, key) => scored[puuid].components.find((c) => c.key === key);

// Team 100: 1 top, 2 jungle, 3 mid, 4 adc, 5 support.
const LANE_BAR = (scored, puuid) => comp(scored, puuid, 'lane').detail;

test('a skirmish elsewhere is not "your jungler helped your lane"', () => {
  // Four mid-lane kills the bot lane assisted in, with the jungler present.
  // These used to count as the jungler handing bot lane its lead, raising the
  // bar for both bot players — which hit supports hardest, since they assist on
  // nearly everything.
  const s = blank();
  for (const m of [6, 8, 10, 12]) {
    add(s, m, { type: 'CHAMPION_KILL', killerId: 3, victimId: 8, assistingParticipantIds: [4, 5, 2], position: MID });
  }
  const scored = score(s);

  assert.ok(!/bar \+/.test(LANE_BAR(scored, 'p5') ?? ''), `support bar was raised: ${LANE_BAR(scored, 'p5')}`);
  assert.ok(!/bar \+/.test(LANE_BAR(scored, 'p4') ?? ''), `adc bar was raised: ${LANE_BAR(scored, 'p4')}`);
});

test('a kill in your own lane still counts as help', () => {
  const s = blank();
  for (const m of [6, 8, 10, 12]) {
    add(s, m, { type: 'CHAMPION_KILL', killerId: 4, victimId: 9, assistingParticipantIds: [5, 2], position: BOT });
  }
  const scored = score(s);
  assert.match(LANE_BAR(scored, 'p4') ?? '', /bar \+/, 'a real bot lane gank should raise the bar');
});

test('roaming off your own lane is credited, not just ignored', () => {
  const stayed = blank();
  const roamed = blank();
  for (const m of [6, 8, 10, 12]) {
    // Same four takedowns, same participants — only the location differs.
    stayed.timeline.info.frames[m].events.push({
      timestamp: m * 60000 + 1, type: 'CHAMPION_KILL', killerId: 4, victimId: 9, assistingParticipantIds: [5], position: BOT
    });
    roamed.timeline.info.frames[m].events.push({
      timestamp: m * 60000 + 1, type: 'CHAMPION_KILL', killerId: 3, victimId: 8, assistingParticipantIds: [5], position: MID
    });
  }

  const roamedPresence = comp(score(roamed), 'p5', 'presence');
  const stayedPresence = comp(score(stayed), 'p5', 'presence');

  assert.match(roamedPresence.detail, /roam TD/, 'the roams should be reported');
  assert.ok(
    roamedPresence.score > stayedPresence.score,
    `roaming ${roamedPresence.score} should beat staying ${stayedPresence.score}`
  );
});

test('kill participation is graded against how this game spread its kills', () => {
  // Same player, same share of their team's kills — but one game is a 38-kill
  // rout of solo picks where nobody could reach a normal participation number.
  // Holds the support at 42% KP and varies only what their teammates managed,
  // which is what sets the "normal involvement in this game" yardstick.
  const spread = (teammateKp) => {
    const s = blank();
    for (const p of s.match.info.participants) {
      if (p.teamId !== 100) continue;
      p.challenges.killParticipation = p.puuid === 'p5' ? 0.42 : teammateKp;
    }
    return comp(score(s), 'p5', 'presence').score;
  };

  const pickHeavy = spread(0.2); // teammates barely assisting: a low-KP game
  const fightHeavy = spread(0.9); // everyone in everything: a high-KP game

  assert.ok(
    pickHeavy > fightHeavy,
    `the same 42% KP should score better in a pick-heavy game (${pickHeavy}) than a teamfight one (${fightHeavy})`
  );
});

test('the adjusted bar is shown when it moved', () => {
  const s = blank();
  for (const p of s.match.info.participants) {
    if (p.teamId === 100) p.challenges.killParticipation = p.puuid === 'p5' ? 0.42 : 0.2;
  }
  assert.match(comp(score(s), 'p5', 'presence').detail, /bar \d+%/);
});
