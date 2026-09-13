// Why one person scored what they did (spec §10.1, §10.2).
//
// The thing that makes an explanation trustworthy rather than plausible is that
// the numbers add up. A composite is a weighted mean anchored at 50, so each
// component's contribution — its share of the weight times its distance from
// par — sums exactly to the distance the composite is from par. If the figures on
// screen do not visibly add up, a reader stops trusting the rest of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { campedTopScenario } from './helpers/matchFixture.js';
import { scoreMatch } from '../src/scoring/index.js';
import { contributions, explainPerformance, distinctNotes } from '../src/explainScore.js';
import { narrate } from '../src/narrate.js';

const lobby = () => {
  const s = campedTopScenario({ durationMinutes: 32 });
  return scoreMatch(s.match, { timeline: s.timeline });
};

/** A stored score shaped like the real game this rework came from. */
const ezreal = () => ({
  composite: 45.7,
  grade: 'D',
  role: 'BOTTOM',
  champion: 'Ezreal',
  kda: '9/9/8',
  win: false,
  components: [
    { key: 'combat', label: 'Damage', weight: 28, score: 48, detail: '27% team dmg · 35% of kills' },
    { key: 'deaths', label: 'Positioning', weight: 20, score: 46, detail: '9 deaths · 3 solo' },
    { key: 'lane', label: 'Lane', weight: 15, score: 41, detail: '+130g @14 (bar +646g)' },
    { key: 'economy', label: 'Farming', weight: 16, score: 43, detail: '6.5 cs/min · 441 gold/min' },
    { key: 'structures', label: 'Objectives', weight: 12, score: 47, detail: '3.1k turret dmg' },
    { key: 'presence', label: 'Presence', weight: 6, score: 49, detail: '52% KP' }
  ],
  context: {
    goldDiff14: 130,
    netJunglePressure: -1.7,
    benchMinute: 14,
    csPerMin: 6.5,
    goldPerMin: 441,
    minutes: 33,
    deaths: 9,
    deathTags: { solo: 3, deep: 3, teamfight: 4, collapsed: 2 },
    weightedDeaths: 7.9,
    dmgShare: 27,
    killShare: 35,
    turretDamage: 3100,
    kp: 52,
    lateKp: 58
  },
  notes: ['jungler committed ×1.7 here (lane bar raised)', '3 deaths alone in enemy half']
});

// --- the arithmetic ----------------------------------------------------------

test('the contributions add up to the score', () => {
  for (const scored of Object.values(lobby())) {
    const c = contributions(scored);
    const summed = c.parts.reduce((s, p) => s + p.contribution, 0);
    assert.ok(
      Math.abs(summed - (scored.composite - 50)) < 0.15,
      `${scored.role}: parts sum to ${summed.toFixed(2)} but the score is ${(scored.composite - 50).toFixed(2)} off par`
    );
  }
});

test('the figures on screen visibly add up to the score', () => {
  // The first version listed two reasons worth −2.6 under a game 4.3 below par,
  // with a footer claiming they summed to the gap. The remainder line is what
  // makes the account complete.
  const e = explainPerformance(ezreal());
  const shown = e.reasons.reduce((s, r) => s + r.contribution, 0);
  const rest = e.parts.filter((p) => !e.reasons.some((r) => r.key === p.key)).reduce((s, p) => s + p.contribution, 0);
  assert.ok(Math.abs(shown + rest - e.fromPar) < 0.2, `shown ${shown.toFixed(1)} + rest ${rest.toFixed(1)} vs ${e.fromPar}`);
  assert.ok(e.remainder, 'whatever is not told as a reason is still accounted for');
});

test('a heavy component that barely moved beats a light one that soared', () => {
  const c = contributions({
    composite: 60,
    components: [
      { key: 'combat', label: 'Damage', weight: 28, score: 62, detail: null }, // 9.9
      { key: 'presence', label: 'Presence', weight: 6, score: 95, detail: null } // 7.9
    ]
  });
  assert.equal(c.parts[0].key, 'combat');
  assert.ok(c.parts[0].score < c.parts[1].score, 'even though it scored lower');
});

test('a light component can still lead if it went far enough', () => {
  const c = contributions({
    composite: 55,
    components: [
      { key: 'combat', label: 'Damage', weight: 28, score: 58, detail: null }, // 6.6
      { key: 'presence', label: 'Presence', weight: 6, score: 90, detail: null } // 7.1
    ]
  });
  assert.equal(c.parts[0].key, 'presence');
});

// --- the words ---------------------------------------------------------------

test('the verdict describes the gap, not the grade', () => {
  // 45.7 is a D. Calling it "a poor game" described a 4-point miss the same way
  // as a 14-point one.
  const e = explainPerformance(ezreal());
  assert.match(e.summary, /^A little below par/);
  assert.doesNotMatch(e.summary, /poor|bad/i);
});

test('the summary names what pushed the score the way it went', () => {
  // It once said "a bad game, and mostly deaths" about a game where deaths were
  // the only thing that went right.
  for (const scored of Object.values(lobby())) {
    const e = explainPerformance(scored);
    const pushedAgainst = e.reasons.filter((r) => (e.fromPar < 0 ? r.contribution > 0 : r.contribution < 0));
    for (const r of pushedAgainst) {
      assert.ok(
        !e.summary.includes(`mostly ${r.label.toLowerCase()}`),
        `"${e.summary}" credits ${r.label}, which pulled the other way`
      );
    }
  }
});

test('a lane graded against jungle help says so in words', () => {
  // The whole reason the old line was uninformative: "+130g @14 (bar +646g)" is
  // accurate and means nothing until someone says the jungler camped the lane.
  const lane = narrate(ezreal().components.find((c) => c.key === 'lane'), ezreal());
  assert.match(lane.why, /130g ahead/);
  assert.match(lane.why, /jungler spent a lot of time in your lane/);
  assert.match(lane.why, /646g/, 'and names the lead that was expected');
  assert.ok(lane.fix, 'a below-par component says what would have lifted it');
});

test('every number is given against what the role normally does', () => {
  const s = ezreal();
  const farming = narrate(s.components.find((c) => c.key === 'economy'), s);
  assert.match(farming.why, /6\.5 CS a minute/);
  assert.match(farming.why, /7\.\d an ADC usually manages/, 'a figure without par explains nothing');
  assert.match(farming.why, /CS short/, 'and how much that amounts to');
});

test('it says "an ADC", not "a ADC"', () => {
  const s = ezreal();
  for (const c of s.components) {
    const told = narrate(c, s);
    assert.doesNotMatch(`${told.why} ${told.fix ?? ''}`, /\ba ADC\b/);
  }
});

test('advice is only given where it is the actual cause', () => {
  // 27% damage against a 23% bar, and 35% of the kills — conversion of 1.3x
  // par. The first version told this player to turn their damage into kills.
  const s = ezreal();
  const damage = narrate(s.components.find((c) => c.key === 'combat'), s);
  assert.doesNotMatch(damage.fix ?? '', /into kills/, 'conversion was not the problem here');
});

test('advice does name conversion when conversion is the problem', () => {
  const s = ezreal();
  s.context.dmgShare = 40;
  s.context.killShare = 12; // lots of damage, few kills
  const damage = narrate(s.components.find((c) => c.key === 'combat'), s);
  assert.match(damage.why, /didn't turn into kills/);
  assert.match(damage.fix ?? '', /into kills/);
});

test('a note the paragraphs already tell is not repeated', () => {
  // "jungler committed ×1.7" is exactly what the lane paragraph says in words,
  // without printing 1.7 — so matching on figures alone would miss it.
  const e = explainPerformance(ezreal());
  const extra = distinctNotes(ezreal().notes, e.reasons);
  assert.ok(!extra.some((n) => /jungler committed/.test(n)), 'told by the lane paragraph');
  assert.ok(!extra.some((n) => /alone in enemy half/.test(n)), 'told by the positioning paragraph');
});

test('a note whose component was not told still appears', () => {
  const extra = distinctNotes(['jungler committed ×1.7 here (lane bar raised)'], [{ key: 'combat', why: 'x' }]);
  assert.equal(extra.length, 1, 'nothing on screen said it, so it is still worth saying');
});

// --- how much is told --------------------------------------------------------

test('it tells a handful of reasons, not every component', () => {
  for (const scored of Object.values(lobby())) {
    assert.ok(explainPerformance(scored).reasons.length <= 4);
  }
});

test('a substantial fourth reason is not hidden behind an arbitrary cap', () => {
  // A flat three hid a −3.6 while showing a −4.5 directly above it.
  const e = explainPerformance({
    composite: 30,
    role: 'JUNGLE',
    components: [
      { key: 'pressure', label: 'Gank impact', weight: 16, score: 10, detail: null },
      { key: 'tempo', label: 'Tempo', weight: 16, score: 22, detail: null },
      { key: 'objectives', label: 'Objectives', weight: 20, score: 28, detail: null },
      { key: 'combat', label: 'Teamfight', weight: 22, score: 34, detail: null },
      { key: 'vision', label: 'Vision', weight: 10, score: 49, detail: null }
    ]
  });
  assert.ok(e.reasons.some((r) => r.key === 'combat'), 'a component this large is part of the story');
});

test('a quiet game is not padded with components that barely moved', () => {
  const e = explainPerformance({
    composite: 51,
    components: [
      { key: 'combat', label: 'Damage', weight: 50, score: 53, detail: null },
      { key: 'deaths', label: 'Deaths', weight: 30, score: 50.3, detail: null },
      { key: 'vision', label: 'Vision', weight: 20, score: 50.2, detail: null }
    ]
  });
  assert.ok(e.reasons.length <= 1, `a 0.1-point contribution is rounding, not a reason (${e.reasons.length} told)`);
});

test('rounding is not reported as a reason', () => {
  const e = explainPerformance({ composite: 50.2, components: [] });
  assert.equal(e.reasons.length, 0);
  assert.match(e.summary, /Right around par/);
});

test('a component the model could not score is left out, not called zero', () => {
  const c = contributions({
    composite: 55,
    components: [
      { key: 'lane', label: 'Lane', weight: 25, score: null, detail: null },
      { key: 'combat', label: 'Damage', weight: 28, score: 60, detail: null }
    ]
  });
  assert.equal(c.parts.length, 1);
});

test('an older game with no stored facts falls back rather than going blank', () => {
  // Scored before the facts were kept. The detail line is still accurate, and
  // /rescore fills the facts in.
  const s = ezreal();
  delete s.context;
  const lane = narrate(s.components.find((c) => c.key === 'lane'), s);
  assert.equal(lane.fromFacts, false);
  assert.match(lane.why, /130g/, 'still says something true');
});

test('a good game is explained as readily as a bad one', () => {
  const s = campedTopScenario({ durationMinutes: 34 });
  const me = s.match.info.participants.find((p) => p.participantId === 8);
  me.kills = 13;
  me.deaths = 2;
  me.assists = 10;
  me.totalDamageDealtToChampions = 41000;
  me.challenges.teamDamagePercentage = 0.37;
  me.challenges.damagePerMinute = 1200;
  me.challenges.killParticipation = 0.74;

  const e = explainPerformance(scoreMatch(s.match, { timeline: s.timeline }).p8);
  assert.ok(e.fromPar > 0);
  assert.match(e.summary, /above par|good game|strong game/i);
  assert.ok(e.reasons.some((r) => r.contribution > 0), 'a strong game has to name what carried it');
});
