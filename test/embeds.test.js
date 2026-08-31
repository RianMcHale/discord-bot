// Discord silently rejects an embed that breaks its limits, so the scorecard is
// checked against them rather than eyeballed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMatchEmbed, postScorecards, enemySummary, weakest, scoreBar, roleInfo } from '../src/embeds.js';
import { scoreMatch } from '../src/scoring/index.js';
import { campedTopScenario } from './helpers/matchFixture.js';

const { match, timeline } = campedTopScenario();
const scores = scoreMatch(match, { timeline, trackedPuuids: [] });

const SQUAD = { p1: 'd1', p2: 'd2', p3: 'd3', p4: 'd4', p5: 'd5' };
const scoresByDiscordId = Object.fromEntries(Object.entries(SQUAD).map(([puuid, id]) => [id, scores[puuid]]));
const nameByDiscordId = { d1: 'TopPlayer', d2: 'JunglePlayer', d3: 'MidPlayer', d4: 'AdcPlayer', d5: 'SupPlayer' };

const build = (opts = {}) =>
  buildMatchEmbed({ scoresByDiscordId, nameByDiscordId, durationSeconds: match.info.gameDuration, hasTimeline: true, enemy: enemySummary(scores, 100), ...opts }).embed.toJSON();

// Discord counts embed characters the way it documents them: the sum of title,
// description, field names, field values and footer — across every embed in the
// message, not per embed. Measuring one embed in isolation is what let a
// five-scorecard reply ship and get rejected with MAX_EMBED_SIZE_EXCEEDED.
const DISCORD_EMBED_BUDGET = 6000;

function embedChars(j) {
  return (
    (j.title?.length ?? 0) +
    (j.description?.length ?? 0) +
    (j.footer?.text?.length ?? 0) +
    (j.author?.name?.length ?? 0) +
    (j.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0)
  );
}

test('a single scorecard fits Discord’s limits', () => {
  for (const detail of [false, true]) {
    const j = build({ detail, alsoNew: 3 });
    assert.ok(embedChars(j) <= DISCORD_EMBED_BUDGET, `embed too large with detail=${detail}: ${embedChars(j)}`);
    assert.ok(j.fields.length <= 25, `too many fields with detail=${detail}`);
    for (const f of j.fields) {
      assert.ok(f.name.length <= 256, `field name too long: ${f.name}`);
      assert.ok(f.value.length <= 1024, `field value too long: ${f.name}`);
    }
    if (j.description) assert.ok(j.description.length <= 4096);
    assert.ok(j.footer.text.length <= 2048);
  }
});

test('batching a run’s worth of scorecards would exceed the message budget', () => {
  // The failure that motivated the one-per-message rule: five games scored in one
  // run, all put into a single reply. There is no safe batch size worth guessing
  // at — a summary card grows with squad size, notes and champion names.
  const detailed = embedChars(build({ detail: true }));
  assert.ok(detailed * 5 > DISCORD_EMBED_BUDGET, 'a full run cannot share one message');
});

test('postScorecards sends exactly one embed per message', async () => {
  const sent = { editReply: [], followUp: [] };
  const interaction = {
    async editReply(payload) {
      sent.editReply.push(payload);
    },
    async followUp(payload) {
      sent.followUp.push(payload);
    }
  };

  const embeds = [build(), build(), build()];
  const count = await postScorecards(interaction, embeds);

  assert.equal(count, 3);
  assert.equal(sent.editReply.length, 1, 'the first goes in the deferred reply');
  assert.equal(sent.followUp.length, 2, 'the rest follow as separate messages');
  for (const payload of [...sent.editReply, ...sent.followUp]) {
    assert.equal(payload.embeds.length, 1, 'never more than one embed per message');
    assert.ok(embedChars(payload.embeds[0]) <= DISCORD_EMBED_BUDGET);
  }
});

test('postScorecards sends nothing when there is nothing to post', async () => {
  let called = false;
  const interaction = {
    async editReply() {
      called = true;
    },
    async followUp() {
      called = true;
    }
  };
  assert.equal(await postScorecards(interaction, []), 0);
  assert.equal(called, false);
});

test('one card per squad player, best to worst', () => {
  const j = build();
  const cards = j.fields.filter((f) => f.inline);
  assert.equal(cards.length, 5);

  const scoresInOrder = cards.map((f) => Number(f.value.match(/\*\*(\d+\.\d)\*\*/)[1]));
  const descending = [...scoresInOrder].sort((a, b) => b - a);
  assert.deepEqual(scoresInOrder, descending);
});

test('marks the worst player and gives them the bench field', () => {
  const j = build();
  const marked = j.fields.filter((f) => f.name.includes('🔻'));
  assert.equal(marked.length, 1, 'exactly one player is flagged');

  const bench = j.fields.find((f) => f.name.includes('Bench watch'));
  assert.ok(bench, 'the bench call always appears');
  // The farming jungler is the worst in this fixture.
  assert.match(bench.value, /<@d2>/);
});

test('context flags appear once, on the section and not the cards', () => {
  const j = build();
  const cards = j.fields.filter((f) => f.inline);
  for (const card of cards) {
    assert.ok(!/camped ×/.test(card.value), 'cards must stay a uniform height');
  }
  const worthKnowing = j.fields.find((f) => f.name.includes('Worth knowing'));
  assert.ok(worthKnowing, 'the camped top laner should be flagged somewhere');
  assert.match(worthKnowing.value, /camped/i);
});

test('detail mode adds a full breakdown per player and nothing else', () => {
  const summary = build();
  const detailed = build({ detail: true });
  assert.equal(detailed.fields.length, summary.fields.length + 5);
  const breakdown = detailed.fields.find((f) => f.name.includes('JunglePlayer'));
  // Every component in the jungle rubric, with its weight.
  assert.match(breakdown.value, /Objectives/);
  assert.match(breakdown.value, /Tempo & map control/);
  assert.match(breakdown.value, /24%/);
});

test('warns when the timeline was unavailable', () => {
  assert.ok(!build({ hasTimeline: true }).description);
  assert.match(build({ hasTimeline: false }).description, /Timeline unavailable/);
});

test('mentions the remaining backlog only when there is one', () => {
  assert.ok(!build({ alsoNew: 0 }).fields.some((f) => /still queued/.test(f.value)));
  assert.match(
    build({ alsoNew: 1 }).fields.find((f) => /still queued/.test(f.value)).value,
    /1 more new shared match still queued/
  );
  assert.match(
    build({ alsoNew: 4 }).fields.find((f) => /still queued/.test(f.value)).value,
    /4 more new shared matches still queued/
  );
});

test('weakest returns the lowest scoring components, ignoring unscored ones', () => {
  const withNull = { components: [
    { key: 'a', label: 'A', score: 70 },
    { key: 'b', label: 'B', score: null },
    { key: 'c', label: 'C', score: 20 },
    { key: 'd', label: 'D', score: 45 }
  ] };
  assert.deepEqual(weakest(withNull, 2).map((c) => c.key), ['c', 'd']);
  assert.equal(weakest(withNull).length, 1);
});

test('the score bar is always ten characters', () => {
  for (const score of [0, 4, 50, 99.9, 100]) {
    assert.equal([...scoreBar(score)].length, 10, `bar wrong length for ${score}`);
  }
});

test('an unrecognised role still renders', () => {
  const info = roleInfo('SOMETHING_NEW');
  assert.ok(info.emoji && info.label && info.abbrev);
});
