// `/explain` is not decoration. The spec calls it non-optional for a reason that
// is really finding F7: if the squad cannot look up what a metric means, the
// bot's authority rests on nobody checking, which is exactly the failure mode it
// was built to replace.
//
// So the thing worth testing is not that the command renders — it is that what
// it says is TRUE. A glossary that drifts from the model is worse than no
// glossary, because it is confidently wrong to the one person who came to check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { campedTopScenario } from './helpers/matchFixture.js';
import { scoreMatch } from '../src/scoring/index.js';
import { BASELINE } from '../src/scoring/roles.js';
import { RUBRICS, COMPONENTS, METRICS, lookup, barsFor, usedBy, explainableIds } from '../src/scoring/glossary.js';
import * as explain from '../src/commands/explain.js';

const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

/** The weights the model actually applies, at the reference game length. */
function liveRubrics() {
  const s = campedTopScenario({ durationMinutes: 27 });
  const scored = scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] });
  const out = {};
  for (const pid of [1, 2, 3, 4, 5]) {
    const p = scored[`p${pid}`];
    out[p.role] = Object.fromEntries(p.components.map((c) => [c.key, c.weight]));
  }
  return out;
}

test('the published weights are the weights the model uses', () => {
  // The whole point. A number in the glossary that has drifted from roles.js
  // fails here rather than quietly misinforming somebody.
  const live = liveRubrics();
  for (const role of ROLES) {
    assert.deepEqual(
      RUBRICS[role],
      live[role],
      `${role}'s published rubric does not match what it is actually scored on`
    );
  }
});

test('every rubric published sums to 100', () => {
  for (const role of ROLES) {
    const total = Object.values(RUBRICS[role]).reduce((a, b) => a + b, 0);
    assert.equal(total, 100, `${role} publishes weights summing to ${total}`);
  }
});

test('every component the model produces can be looked up', () => {
  // A scorecard that shows a component `/explain` has never heard of is the
  // drift this file exists to catch.
  const live = liveRubrics();
  for (const role of ROLES) {
    for (const key of Object.keys(live[role])) {
      assert.ok(COMPONENTS[key], `${role} is scored on "${key}" and nothing explains it`);
    }
  }
});

test('every metric a component claims to be built from exists', () => {
  for (const [key, c] of Object.entries(COMPONENTS)) {
    for (const m of c.metrics) {
      assert.ok(METRICS[m], `${key} says it uses "${m}", which is not a metric`);
    }
  }
});

test('every metric with a bar names a real baseline field', () => {
  // The bars are read live out of the calibration, so a typo here would print
  // "undefined" as the number someone is being measured against.
  for (const [id, m] of Object.entries(METRICS)) {
    if (!m.bar) continue;
    const found = ROLES.some((r) => BASELINE[r]?.[m.bar] != null);
    assert.ok(found, `${id} claims a bar "${m.bar}" that no role has`);
  }
});

test('the bars printed are the live calibrated ones, not copies', () => {
  // Reading them from BASELINE rather than restating them is what stops the
  // glossary going stale the next time the sample is rebuilt.
  const bars = barsFor(METRICS.killPerDamageShare);
  assert.ok(bars.length === 5);
  for (const b of bars) assert.equal(b.value, BASELINE[b.role].killPerDamageShare);

  // And the ordering it documents is the measured one: junglers convert damage
  // into kills best, top laners least, because bruisers chip where assassins
  // execute.
  const by = Object.fromEntries(bars.map((b) => [b.role, b.value]));
  assert.ok(by.JUNGLE > by.TOP, 'the note about conversion by role has to still be true');
});

test('a metric knows which components use it and what they weigh', () => {
  const uses = usedBy('wDeathsPerMin');
  assert.ok(uses.some((u) => u.key === 'deaths'));
  const deaths = uses.find((u) => u.key === 'deaths');
  assert.equal(deaths.weights.length, 5, 'every role is graded on deaths');
  assert.equal(deaths.weights.find((w) => w.role === 'BOTTOM').weight, 20);
});

// --- the command itself ------------------------------------------------------

const reply = async (term) => {
  let out = null;
  await explain.execute({
    options: { getString: () => term ?? null },
    async reply(p) {
      out = p;
    }
  });
  return typeof out === 'string' ? { description: out, fields: [] } : out.embeds[0].toJSON();
};

test('with no term it publishes the whole formula', () => {
  // §12.3's sixth anti-gaming measure, and the cheapest: six people reading each
  // other's breakdowns is a better fraud detector than any code.
  return reply().then((j) => {
    assert.match(j.title, /How the score is built/);
    const weights = j.fields.find((f) => f.name.includes('Weights by role'));
    assert.ok(weights);
    for (const role of ROLES) assert.match(weights.value, new RegExp(role));
    // And it says what it does not know, permanently and without being asked.
    const not = j.fields.find((f) => f.name === 'Not measured');
    assert.ok(not, 'the disclosure belongs here too');
    assert.match(not.value, /Communication/);
  });
});

test('a component explains its weight in every role that has it', async () => {
  const j = await reply('deaths');
  assert.match(j.title, /Deaths/);
  const w = j.fields.find((f) => f.name.includes('Weight in each role'));
  assert.match(w.value, /BOTTOM \*\*20\*\*/);
  assert.match(w.value, /JUNGLE \*\*9\*\*/);
});

test('a metric explains what par actually is', async () => {
  const j = await reply('killPerDamageShare');
  const par = j.fields.find((f) => f.name.includes('par'));
  assert.ok(par, 'a bar nobody can see is not a published formula');
  assert.match(par.value, /JUNGLE/);
  assert.match(par.value, /50 on the scorecard/);
});

test('it is looked up by label as well as by id', async () => {
  const byId = await reply('combat');
  const byLabel = await reply('Teamfight / Damage');
  assert.equal(byId.title, byLabel.title);
});

test('an unknown term suggests rather than shrugs', async () => {
  const j = await reply('deatsh');
  assert.match(j.description, /No part of the score is called/);
  assert.match(j.description, /deaths/, 'a near miss should offer the real one');
});

test('autocomplete offers real ids only', async () => {
  let offered = null;
  await explain.autocomplete({
    options: { getFocused: () => 'kill' },
    async respond(choices) {
      offered = choices;
    }
  });
  assert.ok(offered.length > 0);
  for (const c of offered) {
    assert.ok(explainableIds().includes(c.value), `${c.value} is offered but cannot be explained`);
    assert.ok(c.name.length <= 100, 'Discord rejects choice names over 100 characters');
  }
});
