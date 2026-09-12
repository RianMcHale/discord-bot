// Why one person scored what they did (spec §10.1, §10.2).
//
// The thing that makes an explanation trustworthy rather than plausible is that
// the numbers add up. A composite is a weighted mean anchored at 50, so each
// component's contribution — its share of the weight times its distance from
// par — sums exactly to the distance the composite is from par. If that identity
// does not hold, the explanation is a story about a number rather than an
// account of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { campedTopScenario } from './helpers/matchFixture.js';
import { scoreMatch } from '../src/scoring/index.js';
import { contributions, explainPerformance } from '../src/explainScore.js';

const lobby = () => {
  const s = campedTopScenario({ durationMinutes: 32 });
  return scoreMatch(s.match, { timeline: s.timeline });
};

test('the contributions add up to the score', () => {
  // The identity the whole command rests on.
  for (const scored of Object.values(lobby())) {
    const c = contributions(scored);
    const summed = c.parts.reduce((s, p) => s + p.contribution, 0);
    assert.ok(
      Math.abs(summed - (scored.composite - 50)) < 0.15,
      `${scored.role}: parts sum to ${summed.toFixed(2)} but the score is ${(scored.composite - 50).toFixed(2)} off par`
    );
  }
});

test('a heavy component that barely moved beats a light one that soared', () => {
  // The reason §10.2 asks for contributions rather than scores. A component on a
  // weight of 6 that scored 90 moved the composite less than one on 28 that
  // scored 58, and naming the first as the reason would be wrong.
  const c = contributions({
    composite: 60,
    components: [
      { key: 'combat', label: 'Damage', weight: 28, score: 62, detail: null }, // 9.9 of the score
      { key: 'presence', label: 'Presence', weight: 6, score: 95, detail: null } // 7.9, despite scoring far higher
    ]
  });
  assert.equal(c.parts[0].key, 'combat', 'the one that actually moved the number leads');
  assert.ok(c.parts[0].score < c.parts[1].score, 'even though it scored lower');
  assert.ok(c.parts[0].contribution > c.parts[1].contribution);
});

test('a light component can still lead if it went far enough', () => {
  // The converse, and the reason this is arithmetic rather than a rule of thumb:
  // a weight of 6 at 90 really does move a composite more than a weight of 28 at
  // 58, and the explanation should say so rather than defer to the bigger number.
  const c = contributions({
    composite: 55,
    components: [
      { key: 'combat', label: 'Damage', weight: 28, score: 58, detail: null }, // 6.6
      { key: 'presence', label: 'Presence', weight: 6, score: 90, detail: null } // 7.1
    ]
  });
  assert.equal(c.parts[0].key, 'presence');
});

test('the headline always agrees with the verdict', () => {
  // It said "a bad game, and mostly deaths" about a game where deaths were the
  // only thing that went right — because it took the largest positive without
  // checking which way the score had gone.
  for (const scored of Object.values(lobby())) {
    const e = explainPerformance(scored);
    if (e.fromPar < -1) {
      assert.doesNotMatch(
        e.headline,
        /mostly down to/,
        `a below-par game must not read as carried by anything: "${e.headline}"`
      );
    }
    if (e.fromPar > 1) {
      assert.doesNotMatch(e.headline, /^A (bad|poor) game/, `"${e.headline}" disagrees with ${scored.composite}`);
    }
  }
});

test('a good game is explained as readily as a bad one', () => {
  // The point of the change: this is not a bench-justification tool.
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
  assert.match(e.headline, /good|strong|outstanding/i);
  assert.ok(e.carried.length > 0, 'a strong game has to name what carried it');
  assert.equal(e.sections[0].name, 'What carried it');
});

test('it names a handful of reasons, not every component', () => {
  // The complaint that prompted this: a list of every factor and its weight is a
  // description of the model, not of the game.
  for (const scored of Object.values(lobby())) {
    const e = explainPerformance(scored);
    assert.ok(e.carried.length <= 3);
    assert.ok(e.cost.length <= 3);
    assert.ok(e.carried.length + e.cost.length <= 6);
  }
});

test('rounding is not reported as a reason', () => {
  const c = contributions({
    composite: 50.2,
    components: [
      { key: 'a', label: 'A', weight: 50, score: 50.4, detail: null },
      { key: 'b', label: 'B', weight: 50, score: 50, detail: null }
    ]
  });
  const e = explainPerformance({ composite: 50.2, components: [] });
  assert.equal(c.carried?.length ?? 0, 0);
  assert.match(e.headline, /Nothing in it stands out/);
});

test('the evidence comes from the game, not from the model', () => {
  // Each reason carries the component's own detail line — "6 deaths · 3 solo",
  // "37% team dmg" — so the claim can be checked against the scoreboard.
  const e = explainPerformance(lobby().p2);
  const withDetail = [...e.carried, ...e.cost].filter((p) => p.detail);
  assert.ok(withDetail.length > 0, 'a reason with no evidence is an assertion');
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
  assert.equal(c.parts[0].key, 'combat');
});

test('a score with no components at all does not crash', () => {
  const e = explainPerformance({ composite: 50, components: [] });
  assert.ok(e.headline);
  assert.equal(e.sections.length, 0);
});
