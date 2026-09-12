// Damage share misses conversion from both directions: an assassin turns less
// total damage into more kills, and a mage chipping a whole teamfight racks up
// damage that killed nobody. Jungle felt it worst, being the only rubric with no
// participation component at all — a jungler on 40% of their team's kills was
// invisible.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatch } from '../src/scoring/index.js';
import { BASELINE } from '../src/scoring/roles.js';
import { plainMatch } from './helpers/matchFixture.js';

/**
 * Redistributes one team's kills so `participantId` takes `share` of them,
 * holding the team total and every player's damage fixed. Only conversion
 * changes: same damage, different number of kills to show for it.
 */
function withKillShare(participantId, share, { totalKills = 40 } = {}) {
  const match = plainMatch({ durationSeconds: 30 * 60 });
  const team = match.info.participants.filter((p) => p.teamId === (participantId <= 5 ? 100 : 200));
  const mine = Math.round(totalKills * share);
  const rest = totalKills - mine;
  const others = team.filter((p) => p.participantId !== participantId);
  for (const p of team) {
    p.kills = p.participantId === participantId ? mine : Math.round(rest / others.length);
    // Hold kill participation flat so this isolates kill share from KP.
    p.challenges.killParticipation = 0.55;
  }
  return scoreMatch(match, { timeline: null, trackedPuuids: [] });
}

const combatOf = (scored, key) => scored[key].components.find((c) => c.key === 'combat').score;

test('the kill-share baselines sum to a whole team', () => {
  const total = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'].reduce((s, r) => s + BASELINE[r].killShare, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `shares of one team's kills must sum to 1, got ${total}`);
});

test('a jungler who took most of the team’s kills scores better for it', () => {
  const quiet = withKillShare(2, 0.1);
  const carried = withKillShare(2, 0.4);
  assert.ok(
    combatOf(carried, 'p2') > combatOf(quiet, 'p2') + 5,
    `40% of the team's kills should beat 10% (${combatOf(quiet, 'p2')} -> ${combatOf(carried, 'p2')})`
  );
});

test('it is a correction to damage share, not a replacement for it', () => {
  // Same damage in both. If kill share were doing the heavy lifting, the gap
  // between a 10% and a 40% share would be far wider than this.
  const quiet = combatOf(withKillShare(2, 0.1), 'p2');
  const carried = combatOf(withKillShare(2, 0.4), 'p2');
  assert.ok(carried - quiet < 20, `kills must not dominate the component (moved ${(carried - quiet).toFixed(1)})`);
});

test('a jungler cannot reach a good Teamfight score on kills alone', () => {
  // The whole model exists to get away from grading on KDA. Taking every kill
  // on the team while doing no damage is a warning sign, not an A.
  const match = plainMatch({ durationSeconds: 30 * 60 });
  for (const p of match.info.participants) {
    if (p.teamId !== 100) continue;
    p.kills = p.participantId === 2 ? 30 : 0;
    if (p.participantId === 2) {
      p.challenges.teamDamagePercentage = 0.05;
      p.challenges.damagePerMinute = 200;
      p.totalDamageDealtToChampions = 6000;
    }
  }
  const scored = scoreMatch(match, { timeline: null, trackedPuuids: [] });
  assert.ok(combatOf(scored, 'p2') < 55, `kill-stealing to 100% must not score well (${combatOf(scored, 'p2')})`);
});

test('every carry role is graded on kill conversion, jungle hardest', () => {
  const spread = (id) => combatOf(withKillShare(id, 0.4), `p${id}`) - combatOf(withKillShare(id, 0.1), `p${id}`);
  const jungle = spread(2);
  const mid = spread(3);
  const adc = spread(4);

  assert.ok(jungle > mid, 'jungle leans on it hardest, having no participation component');
  assert.ok(mid > 0, 'mid is an assassin lane');
  // The ADC was withheld at first on the reasoning that a marksman's damage
  // already tracks their kills. It does not reliably — a poke ADC chips damage
  // that killed nobody, a burst one converts less damage into more kills.
  assert.ok(adc > 0, 'an ADC who converts must not be invisible');

  // The ADC now moves *most*, where it used to move least, and that is the
  // conversion discount rather than the conversion vote. Conversion also scales
  // an above-par damage claim, and an ADC's damage claim is the largest in the
  // lobby — so the credibility check on it bites hardest there. Grading the
  // biggest claim most carefully is the right way round.
  assert.ok(adc > jungle, 'the largest damage claim gets the closest check');

  // Top has solo kills inside Side lane, so it gets no kill-conversion vote —
  // `killShareWeight` is zero there. It is unaffected *here* for a second reason
  // worth stating: this fixture leaves damage at par, and the discount only ever
  // deflates a claim that is above it. A top laner who pads damage is caught,
  // which is what anti-gaming.test.js covers.
  assert.ok(Math.abs(spread(1)) < 0.01, 'top is unaffected while its damage claim is at par');
});

test('the detail line reports kill share only where it counts', () => {
  const scored = withKillShare(2, 0.4);
  const jungle = scored.p2.components.find((c) => c.key === 'combat');
  const adc = scored.p4.components.find((c) => c.key === 'combat');
  const top = scored.p1.components.find((c) => c.key === 'combat');
  assert.match(jungle.detail, /% of kills/);
  assert.match(adc.detail, /% of kills/);
  assert.doesNotMatch(top.detail, /% of kills/, 'no point showing a number that is not being graded');
});

test('a game with no kills at all does not crash or score zero', () => {
  const match = plainMatch({ durationSeconds: 30 * 60 });
  for (const p of match.info.participants) p.kills = 0;
  const scored = scoreMatch(match, { timeline: null, trackedPuuids: [] });
  assert.ok(Number.isFinite(scored.p2.composite));
  assert.equal(scored.p2.context.killShare, null);
});

// Farming was the last component graded purely head-to-head. An Ezreal on 6.7
// cs/min opposite a Jinx on 10.7 scored 34 for a number only a little under par,
// and the identical game opposite a Draven would have scored well.
test('an ADC’s farming is not a verdict on who the enemy ADC picked', () => {
  const farmingAgainst = (theirCs) => {
    const match = plainMatch({ durationSeconds: 41 * 60 });
    const mine = match.info.participants.find((p) => p.participantId === 4);
    const theirs = match.info.participants.find((p) => p.participantId === 9);
    mine.totalMinionsKilled = Math.round(6.7 * 41);
    theirs.totalMinionsKilled = Math.round(theirCs * 41);
    const scored = scoreMatch(match, { timeline: null, trackedPuuids: [] });
    return scored.p4.components.find((c) => c.key === 'economy').score;
  };

  const vsFarmHeavy = farmingAgainst(10.7);
  const vsLowFarm = farmingAgainst(4.5);

  assert.ok(vsFarmHeavy > 38, `6.7 cs/min is under par, not a disaster (${vsFarmHeavy})`);
  assert.ok(vsLowFarm > vsFarmHeavy, 'out-farming them still counts');
  assert.ok(vsLowFarm - vsFarmHeavy < 30, 'but the opponent alone must not decide it');
});

test('every cs comparison in the model is anchored to a baseline', async () => {
  // Jungle farm, mid wave control and ADC farming all compared cs only to the
  // counterpart. Fixing them one at a time is how two of the three stayed broken.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/scoring/roles.js', import.meta.url), 'utf-8')
  );
  const bare = src.split('\n').filter((l) => /versus\(P\.csPerMin, opp\.csPerMin/.test(l) && !/blend\(/.test(l));
  // Each surviving one must sit inside a blend, which spans lines, so check the
  // preceding line opens one.
  const lines = src.split('\n');
  for (const line of bare) {
    const i = lines.indexOf(line);
    const context = lines.slice(Math.max(0, i - 2), i + 4).join('\n');
    assert.match(context, /blend\(/, `unanchored cs comparison:\n${context}`);
  }
});
