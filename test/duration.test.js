// An ADC with one item does a fraction of the damage they do with five. Damage
// share was graded against one fixed number at every game length, so a short
// game marked every ADC down and every top laner up — a verdict on the clock
// rather than on the player.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch } from '../src/scoring/index.js';
import { BASELINE, expectedDmgShare } from '../src/scoring/roles.js';
import { plainMatch } from './helpers/matchFixture.js';

const ctxAt = (minutes) => ({ minutes });

test('the damage bar moves with game length, in the direction each role scales', () => {
  const at = (role, mins) => expectedDmgShare({ role }, ctxAt(mins), BASELINE[role]);

  // Marksmen scale hardest, so their bar climbs the most.
  assert.ok(at('BOTTOM', 20) < at('BOTTOM', 40), 'an ADC is expected to do more damage in a long game');
  assert.ok(at('BOTTOM', 40) - at('BOTTOM', 20) > 0.05, 'and by a margin worth correcting for');

  // Bruisers and tanks are nearest their peak early and fade.
  assert.ok(at('TOP', 20) > at('TOP', 40));
  assert.ok(at('JUNGLE', 20) > at('JUNGLE', 40));

  // A support's damage share is flat, and is not graded on damage anyway.
  assert.equal(at('UTILITY', 20), at('UTILITY', 40));
});

test('the 30-minute bar is the baseline itself, so nothing shifts for a normal game', () => {
  for (const role of ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']) {
    assert.equal(expectedDmgShare({ role }, ctxAt(30), BASELINE[role]), BASELINE[role].dmgShare);
  }
});

test('the bar stops moving outside the range real games occupy', () => {
  // A 12-minute remake and a 70-minute marathon must not extrapolate into
  // absurd expectations.
  assert.equal(expectedDmgShare({ role: 'BOTTOM' }, ctxAt(12), BASELINE.BOTTOM), expectedDmgShare({ role: 'BOTTOM' }, ctxAt(18), BASELINE.BOTTOM));
  assert.equal(expectedDmgShare({ role: 'BOTTOM' }, ctxAt(70), BASELINE.BOTTOM), expectedDmgShare({ role: 'BOTTOM' }, ctxAt(45), BASELINE.BOTTOM));
});

/**
 * Both players in `role` doing exactly the damage share that role does in a game
 * of this length. Whatever the clock says, that is an ordinary performance and
 * should score like one.
 */
function typicalGameAt(minutes, role, shareOfTeam) {
  const match = plainMatch({ durationSeconds: minutes * 60 });
  const teamDamage = { 100: 0, 200: 0 };
  for (const p of match.info.participants) teamDamage[p.teamId] += p.totalDamageDealtToChampions;
  for (const p of match.info.participants) {
    if (p.teamPosition !== role) continue;
    p.challenges.teamDamagePercentage = shareOfTeam;
    p.totalDamageDealtToChampions = Math.round(teamDamage[p.teamId] * shareOfTeam);
    p.challenges.damagePerMinute = p.totalDamageDealtToChampions / minutes;
  }
  return scoreMatch(match, { timeline: null, trackedPuuids: [] });
}

test('an ordinary game scores the same whether it ran 20 minutes or 40', () => {
  const damageOf = (mins, role, key) => {
    const share = expectedDmgShare({ role }, ctxAt(mins), BASELINE[role]);
    const scored = typicalGameAt(mins, role, share);
    return scored[key].components.find((c) => c.key === 'combat').score;
  };

  // An ADC on 23% of their team's damage in a 20-minute game did the same job
  // as one on 31% in a 40-minute game. Before the correction the first was
  // marked down by roughly five points for it.
  const shortAdc = damageOf(20, 'BOTTOM', 'p4');
  const longAdc = damageOf(40, 'BOTTOM', 'p4');
  assert.ok(
    Math.abs(longAdc - shortAdc) < 1.5,
    `the same performance should score the same at either length (${shortAdc} -> ${longAdc})`
  );

  // And the correction runs both ways: a top laner is not quietly rewarded for
  // the short game the ADC used to be punished for.
  const shortTop = damageOf(20, 'TOP', 'p1');
  const longTop = damageOf(40, 'TOP', 'p1');
  assert.ok(Math.abs(longTop - shortTop) < 1.5, `top should be flat too (${shortTop} -> ${longTop})`);
});

test('a fixed damage share still falls as the game lengthens, which is the point', () => {
  // The mirror of the test above. An ADC who does 28% in a 40-minute game did
  // relatively less than one who did 28% in a 20-minute game, and the score has
  // to say so — otherwise the bar is not doing anything.
  const flat = (mins) =>
    typicalGameAt(mins, 'BOTTOM', 0.28).p4.components.find((c) => c.key === 'combat').score;
  assert.ok(flat(20) > flat(40) + 2, `${flat(20)} should clearly beat ${flat(40)}`);
});
