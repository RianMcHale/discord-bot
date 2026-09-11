// Finding F4: nearly every raw metric is contaminated by whether the team was
// ahead. Damage share rises when you are winning, because you have more items.
// Scoring it raw means the score partly measures "did your team win", and then
// /worst benches whoever was on the wrong side of a snowball they did not cause.
//
// Damage share divided by gold share is the conditioned version — what you did
// with what you got. It is the metric that separates "he was fed" from "he was
// carrying", which is the distinction the squad kept asking the bot to make.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch } from '../src/scoring/index.js';
import { BASELINE, expectedDmgShare } from '../src/scoring/roles.js';
import { plainMatch } from './helpers/matchFixture.js';

/**
 * An ADC doing `damageShare` of their team's damage on `goldShare` of its gold.
 * The team's total gold is held fixed, so only the split changes.
 */
function adcOn({ goldShare, damageShare = 0.3, minutes = 32 }) {
  const match = plainMatch({ durationSeconds: minutes * 60 });
  const team = match.info.participants.filter((p) => p.teamId === 100);
  const total = team.reduce((s, p) => s + p.goldEarned, 0);
  const mine = team.find((p) => p.participantId === 4);
  const others = team.filter((p) => p.participantId !== 4);
  const want = Math.round(total * goldShare);
  const spare = (want - mine.goldEarned) / others.length;
  mine.goldEarned = want;
  for (const p of others) p.goldEarned = Math.round(p.goldEarned - spare);
  mine.challenges.teamDamagePercentage = damageShare;
  return scoreMatch(match, { timeline: null, trackedPuuids: [] });
}

/** The conversion bar the rubric derives: expected damage share over gold share. */
const conversionBar = (role, mins) =>
  expectedDmgShare({ role }, { minutes: mins }, BASELINE[role]) / BASELINE[role].goldShare;

const combatOf = (scored) => scored.p4.components.find((c) => c.key === 'combat').score;

test('doing the same damage on less gold scores better', () => {
  // The whole point. Both players did 30% of their team's damage; one needed 30%
  // of its gold to do it and the other needed 20%.
  const fed = combatOf(adcOn({ goldShare: 0.3 }));
  const carrying = combatOf(adcOn({ goldShare: 0.2 }));
  assert.ok(
    carrying > fed + 4,
    `converting resources has to count (${fed} on 30% of the gold -> ${carrying} on 20%)`
  );
});

test('it does not simply invert into a reward for being poor', () => {
  // Taking less gold is not itself a virtue — a support who farms nothing and
  // does nothing must not score well for it. The metric is a ratio, so the
  // damage has to actually be there.
  const poorAndQuiet = combatOf(adcOn({ goldShare: 0.15, damageShare: 0.1 }));
  const richAndLoud = combatOf(adcOn({ goldShare: 0.3, damageShare: 0.34 }));
  assert.ok(richAndLoud > poorAndQuiet, 'low gold with no damage to show for it is not a good game');
});

test('the bar is the role’s own conversion rate, not 1.0', () => {
  // A support's gold buys wards and a mid's buys damage, so par differs by role.
  // Grading everyone against a flat ratio of 1.0 would mark every support down
  // for playing support.
  assert.ok(BASELINE.UTILITY.damagePerGoldShare < BASELINE.MIDDLE.damagePerGoldShare);
  assert.ok(BASELINE.UTILITY.damagePerGoldShare < 0.8, 'a support converts gold into champion damage least');
  assert.ok(BASELINE.MIDDLE.damagePerGoldShare > 1, 'a mid laner converts it most');
});

test('the bar tracks game length, so a short game is not marked down', () => {
  // Damage share climbs with the clock for an ADC and gold share does not, so a
  // stored constant bar would have made every short ADC game look like poor
  // conversion — the same defect the damage-share bar itself had before it was
  // given a slope. The bar is derived as expected damage share over gold share
  // precisely so it inherits that slope rather than needing its own.
  //
  // (The whole-component version of this is duration.test.js, which uses a
  // fixture that holds every other combat term fixed. This checks the bar.)
  const bar = (mins) => conversionBar('BOTTOM', mins);

  assert.ok(bar(40) > bar(20), 'an ADC is expected to convert more in a long game, and the bar has to move with it');
  // And it moves by the same proportion damage share does, since it is that
  // number divided by a constant.
  const damageRatio =
    expectedDmgShare({ role: 'BOTTOM' }, { minutes: 40 }, BASELINE.BOTTOM) /
    expectedDmgShare({ role: 'BOTTOM' }, { minutes: 20 }, BASELINE.BOTTOM);
  assert.ok(Math.abs(bar(40) / bar(20) - damageRatio) < 1e-9);

  // A role with no slope keeps a flat bar rather than acquiring one.
  assert.equal(conversionBar('UTILITY', 20), conversionBar('UTILITY', 40));
});

test('a game with no gold recorded drops the term instead of scoring zero', () => {
  const match = plainMatch({ durationSeconds: 30 * 60 });
  for (const p of match.info.participants) p.goldEarned = 0;
  const scored = scoreMatch(match, { timeline: null, trackedPuuids: [] });
  assert.ok(Number.isFinite(scored.p4.components.find((c) => c.key === 'combat').score));
  assert.ok(Number.isFinite(scored.p4.composite));
});
