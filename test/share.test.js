// `versus` divides by the sum of both values, which is right when two real
// players compete for one pool and wrong against a fixed bar. Against a 26%
// damage-share baseline, a player doing 35% — a dominant carry game — scored
// 58.8, and one doing half their team's entire damage scored 69, while a laner
// 2000g up at 14 scored 92 because gold goes through `fromDiff`. Roles weighted
// toward share metrics were capped a grade below roles weighted toward
// difference metrics, for no reason anyone chose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { versus, versusShare, fromDiff } from '../src/scoring/scale.js';

test('par is exactly 50, so an even game is untouched', () => {
  for (const bar of [0.09, 0.21, 0.26, 0.28, 0.62]) {
    assert.equal(versusShare(bar, bar), 50);
  }
});

test('a dominant share now scores like a dominant lead does', () => {
  // 35% of a team's damage against a 26% bar is the same order of achievement as
  // being 1000g up at 14. They should not be 15 points apart.
  const share = versusShare(0.35, 0.26, { full: 0.75 });
  const lead = fromDiff(1000, 1800);
  assert.ok(share > 70, `35% against a 26% bar should read as strong, got ${share}`);
  assert.ok(Math.abs(share - lead) < 8, `${share} vs ${lead} — the two curves should agree on "strong"`);
});

test('the old curve could not express an exceptional share at all', () => {
  // Half a team's entire damage, which is about as one-sided as League gets.
  assert.ok(versus(0.5, 0.26, { prior: 0.03, gain: 1.25 }) < 70, 'the old ceiling');
  assert.ok(versusShare(0.5, 0.26, { full: 0.75 }) > 88, 'and what it should have been');
});

test('it is symmetric: a poor share is punished as clearly as a good one is rewarded', () => {
  const good = versusShare(0.26 * 1.4, 0.26) - 50;
  const bad = 50 - versusShare(0.26 / 1.4, 0.26);
  assert.ok(good > 15, 'a real edge has to show');
  assert.ok(Math.abs(good - bad) < 12, 'and the curve must not flatter one direction');
});

test('`full` sets how far above par counts as winning the axis outright', () => {
  // 0.6 for kill participation, whose realistic range is narrow; 1.0 for kill
  // share, which varies far more between a carry and a support.
  const narrow = versusShare(0.55 * 1.5, 0.55, { full: 0.6 });
  const wide = versusShare(0.24 * 1.5, 0.24, { full: 1.0 });
  assert.ok(narrow > wide, 'a narrower `full` reaches the top of the scale sooner');
});

test('a missing or zero baseline drops out rather than dividing by nothing', () => {
  assert.equal(versusShare(0.3, 0), null);
  assert.equal(versusShare(0.3, undefined), null);
  assert.equal(versusShare(null, 0.26), null);
  assert.equal(versusShare(NaN, 0.26), null);
});

test('it stays inside 0-100 at any input', () => {
  for (const mine of [0, 0.001, 0.5, 1, 5]) {
    const v = versusShare(mine, 0.26);
    assert.ok(v >= 0 && v <= 100, `${mine} produced ${v}`);
  }
});

// β (spec §5.4.3) is how much of a metric is "did you beat your counterpart"
// versus "did you play well". The squad chose the latter, against the spec's
// 0.70 default.
test('β is set to weight playing well over winning the matchup', async () => {
  const { DIFFERENTIAL_WEIGHT, blend } = await import('../src/scoring/scale.js');
  assert.ok(DIFFERENTIAL_WEIGHT < 0.5, 'absolute performance should be the larger share');
  assert.ok(DIFFERENTIAL_WEIGHT > 0, 'but the matchup still has to count for something');

  // A player who beat a weak counterpart while playing poorly in absolute terms
  // should land nearer the absolute reading than the differential one.
  const flatteredByMatchup = blend(90, 40);
  assert.ok(flatteredByMatchup < 60, `beating a bad opponent badly should not read as good (${flatteredByMatchup})`);
});

test('no rubric sets its own β behind the shared one’s back', async () => {
  // One dial, in one place. A call site quietly passing its own number is how a
  // values decision turns back into scattered magic numbers.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/scoring/roles.js', import.meta.url), 'utf-8')
  );
  assert.doesNotMatch(src, /blend\([^)]*,\s*0\.\d+\s*\)/s, 'blend should take the shared β');
});
