// Finding F7: six people who know the formula and would rather not be benched.
//
// This is the only finding with a live adversary, and the spec's remedy (§12.3)
// is that the composite must contain metrics that *conflict* — you must not be
// able to maximise one axis by abandoning another. These are the synthetic
// profiles that check it, one per exploit the finding names.
//
// The profiles are deliberately extreme. A real attempt would be subtler, and
// the point of testing the extreme is that if the obvious version does not pay,
// the subtle version pays even less.
import test from 'node:test';
import assert from 'node:assert/strict';
import { campedTopScenario } from './helpers/matchFixture.js';
import { scoreMatch } from '../src/scoring/index.js';

const ROLE_OF = { 1: 'TOP', 2: 'JUNGLE', 3: 'MIDDLE', 4: 'BOTTOM', 5: 'UTILITY' };

/** Scores a lobby with one player's line rewritten, and returns that player. */
function played(participantId, mutate = () => {}) {
  const s = campedTopScenario({ durationMinutes: 32 });
  mutate(s.match.info.participants.find((p) => p.participantId === participantId), s);
  return scoreMatch(s.match, { timeline: s.timeline, trackedPuuids: [] })[`p${participantId}`];
}

const combatOf = (scored) => scored.components.find((c) => c.key === 'combat').score;

// --- the exploits F7 names, one at a time -----------------------------------

/**
 * "Deaths are minimisable by not contesting anything."
 *
 * The timeline is edited as well as the summary, and it has to be: deaths are
 * graded from the kill events, weighted by how much of each was the player's
 * fault, not from the summary's death count. Changing only the number leaves the
 * deaths component untouched — which is a small anti-gaming property in itself,
 * and one that would have made this test pass for the wrong reason.
 */
const COWARD = (me, s) => {
  me.kills = 1;
  me.deaths = 1;
  me.assists = 2;
  me.totalMinionsKilled = 320; // farmed all game
  me.goldEarned = 13000;
  me.totalDamageDealtToChampions = 9000;
  me.challenges.killParticipation = 0.12;
  me.challenges.teamDamagePercentage = 0.1;
  me.challenges.damagePerMinute = 280;
  me.challenges.dragonTakedowns = 0;
  me.challenges.riftHeraldTakedowns = 0;

  // Survive everything after the first death by never being there.
  let seen = 0;
  for (const frame of s.timeline.info.frames) {
    frame.events = frame.events.filter((e) => {
      if (e.type !== 'CHAMPION_KILL' || e.victimId !== me.participantId) return true;
      seen += 1;
      return seen <= 1;
    });
  }
};

/** "Kill participation is trivially farmable by walking to fights and auto-attacking once." */
const KP_FARMER = (me) => {
  me.kills = 0;
  me.deaths = 3;
  me.assists = 22;
  me.totalDamageDealtToChampions = 8000;
  me.challenges.killParticipation = 0.92;
  me.challenges.teamDamagePercentage = 0.09;
  me.challenges.damagePerMinute = 250;
};

/** "Damage share is farmable by poking a tanky frontline in a losing teamfight." */
const DAMAGE_PADDER = (me) => {
  me.kills = 1;
  me.deaths = 4;
  me.assists = 5;
  me.totalDamageDealtToChampions = 48000;
  me.challenges.teamDamagePercentage = 0.46;
  me.challenges.damagePerMinute = 1500;
  me.challenges.killParticipation = 0.3;
};

/** The inverse: take the kills off your team without doing the damage. */
const KILL_STEALER = (me) => {
  me.kills = 14;
  me.deaths = 3;
  me.assists = 2;
  me.totalDamageDealtToChampions = 6000;
  me.challenges.teamDamagePercentage = 0.06;
  me.challenges.damagePerMinute = 190;
  me.challenges.killParticipation = 0.55;
};

/** What the model is *supposed* to reward, as the control. */
const GENUINE_CARRY = (me) => {
  me.kills = 12;
  me.deaths = 3;
  me.assists = 9;
  me.totalDamageDealtToChampions = 38000;
  me.challenges.teamDamagePercentage = 0.36;
  me.challenges.damagePerMinute = 1180;
  me.challenges.killParticipation = 0.72;
};

// --- §12.3.1, the spec's own assertion --------------------------------------

test('the coward profile scores below par', () => {
  // High CS, low deaths, low participation, no objectives. The spec names this
  // one explicitly: passive play must lose more on the objective, roaming and
  // participation axes than it gains on deaths.
  const coward = played(3, COWARD);
  assert.ok(coward.composite < 50, `farming safely and contributing nothing is not a passing game (${coward.composite})`);
});

test('not dying is worth less than the impact it costs', () => {
  // The specific trade the coward is making: one death instead of five.
  const ordinary = played(3);
  const coward = played(3, COWARD);
  const deathsOf = (s) => s.components.find((c) => c.key === 'deaths').score;

  assert.ok(deathsOf(coward) > deathsOf(ordinary), 'staying alive does genuinely score better on deaths');
  assert.ok(coward.composite < ordinary.composite, 'and still loses overall, which is the conflict working');
});

// --- the three farmable metrics ---------------------------------------------

test('kill participation cannot be farmed by showing up and doing nothing', () => {
  // 92% KP, and 9% of the team's damage to show for it.
  const farmer = played(3, KP_FARMER);
  assert.ok(farmer.composite < 50, `92% KP on 9% of the damage is not a good game (${farmer.composite})`);
  assert.ok(combatOf(farmer) < 40, 'the damage share it did not earn is what catches it');
});

test('damage share cannot be farmed by poking a frontline', () => {
  // The one that was genuinely open: 46% of the team's damage, one kill. Before
  // the conversion discount this scored 56.7 against an ordinary game's 53.9 —
  // padding paid, in the role most able to do it.
  const ordinary = played(3);
  const padder = played(3, DAMAGE_PADDER);
  assert.ok(
    padder.composite <= ordinary.composite,
    `damage that killed nobody must not beat an ordinary game (${padder.composite} vs ${ordinary.composite})`
  );
});

test('padding is caught in every role, including the one with no kill-share term', () => {
  // Top opts out of kill conversion as a scoring term, which made it the way
  // round the check: padding took a top laner's Teamfight score from 38 to 85.
  // The discount applies regardless of whether the role also votes on it.
  for (const id of [1, 2, 3, 4]) {
    const ordinary = combatOf(played(id));
    const padded = combatOf(played(id, DAMAGE_PADDER));
    const gain = padded - ordinary;
    assert.ok(gain < 20, `${ROLE_OF[id]} gains ${gain.toFixed(1)} combat points for damage that converted nothing`);
  }
});

test('taking the kills without doing the damage is not the way round it either', () => {
  // The inverse exploit the discount could have opened: if conversion is good,
  // inflate it by doing no damage at all. Damage share carries half the
  // component, so it cannot be abandoned.
  const stealer = played(3, KILL_STEALER);
  assert.ok(stealer.composite < 50, `14 kills on 6% of the damage is not a carry (${stealer.composite})`);
  assert.ok(combatOf(stealer) < 40);
});

// --- the control, which matters as much as the exploits ---------------------

test('the checks do not flatten a real carry', () => {
  // An anti-gaming measure that also punishes playing well is not a fix. This is
  // the profile every one of the above is trying to imitate.
  const carry = played(3, GENUINE_CARRY);
  const padder = played(3, DAMAGE_PADDER);
  const ordinary = played(3);

  assert.ok(carry.composite > ordinary.composite, 'carrying has to beat an ordinary game');
  assert.ok(combatOf(carry) > 65, `and read as a strong Teamfight score (${combatOf(carry)})`);
  assert.ok(carry.composite > padder.composite + 4, 'and clearly beat the imitation of it');
});

test('conversion at or above par leaves the damage claim alone', () => {
  // The discount is one-directional. Converting *better* than par must not
  // inflate a damage score beyond what the damage itself earned, or it becomes a
  // new thing to farm.
  const carry = played(3, GENUINE_CARRY);
  const carryPlus = played(3, (me) => {
    GENUINE_CARRY(me);
    me.kills = 20; // far above par conversion on the same damage
  });
  assert.ok(
    combatOf(carryPlus) - combatOf(carry) < 12,
    'converting above par is worth something, but not unbounded'
  );
});
