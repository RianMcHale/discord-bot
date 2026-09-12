// What every part of the score means, in the bot's own words (spec §10.1).
//
// The spec calls `/explain` non-optional, and the reason is F7 rather than
// politeness: if the squad cannot look up what a metric means, the bot's
// authority rests on nobody checking. Six people reading each other's
// breakdowns is a better fraud detector than any code, and they can only do
// that if the formula is published.
//
// Two levels, because the score has two:
//
//   * COMPONENTS are what a scorecard shows — Lane, Teamfight, Deaths. Each has
//     a weight per role, and those weights are what decide a bench.
//   * METRICS are what the components are built from. Each names the bar it is
//     graded against, and the bar is read live out of the calibration rather
//     than written down here, so what the command prints is what the model
//     actually used.
//
// Weights are declared rather than introspected, and `glossary.test.js` asserts
// they match the live rubrics. A number here that drifts from roles.js fails the
// build rather than quietly misinforming the person who came to check.

import { BASELINE } from './roles.js';
import { calibratedRoles } from './calibration.js';

const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

/**
 * Component weights per role at the reference game length (27 minutes).
 *
 * Anything measured only during laning is weighted by how long the game ran, so
 * `lane` and `pressure` drift either side of these away from the reference —
 * a 40-minute game weights laning less, because it decided less of it.
 */
export const RUBRICS = {
  TOP: { lane: 25, sidelane: 15, combat: 22, deaths: 20, objectives: 10, presence: 8 },
  JUNGLE: { objectives: 20, pressure: 16, tempo: 16, combat: 22, economy: 7, vision: 10, deaths: 9 },
  MIDDLE: { lane: 24, combat: 24, roam: 18, deaths: 16, tempo: 10, objectives: 8 },
  BOTTOM: { combat: 28, deaths: 20, lane: 18, economy: 16, structures: 12, presence: 6 },
  UTILITY: { vision: 24, utility: 22, presence: 22, deaths: 12, lane: 12, objectives: 8 }
};

/** Components, keyed as they appear on a scorecard. */
export const COMPONENTS = {
  lane: {
    label: 'Lane',
    what: 'Gold and experience at 14 minutes, against your counterpart and against what your role normally has by then.',
    how:
      'Blended two ways: 35% "did you beat the player opposite you", 65% "did you play well". ' +
      'The bar moves with jungle pressure — a top laner ganked three times is measured against an expected deficit, not against zero. ' +
      'Out-earning them after laning ends is credited on top, in proportion to how much of the deficit it erased.',
    watch:
      'It cannot tell a lane you lost from a lane you were never in. Bot lane is graded on the pair, so a support does not inherit their ADC’s farm.',
    metrics: ['gold14', 'xp14', 'goldDiff14']
  },
  combat: {
    label: 'Teamfight / Damage',
    what: 'What you contributed to fights: damage share, damage taken share, what you did with the gold you had, and whether the damage converted into kills.',
    how:
      'Damage volume reaches this three ways, so it is checked once: an above-par damage claim is scaled by how well it converted into kills, capped at par. ' +
      'Doing 46% of the team’s damage and taking one kill is discounted heavily; doing it and taking a third of the kills is not discounted at all.',
    watch:
      'Deliberately hard to farm from either end. Padding damage into a frontline loses to the conversion check; taking kills without doing damage loses to the damage share that carries half the component.',
    metrics: ['dmgShare', 'tankShare', 'damagePerGoldShare', 'killPerDamageShare', 'lateKp']
  },
  deaths: {
    label: 'Deaths / Positioning',
    what: 'Deaths per minute, weighted by how much of each one was actually yours.',
    how:
      'Read from the timeline, not the scoreboard. A death alone in the enemy jungle counts more than one in a five-man fight, and a death to a gank you had no vision of counts less. ' +
      'Graded against your counterpart and against the role baseline, so a lane where both players inted does not produce a winner.',
    watch:
      'Because it is built from kill events rather than the summary, the death count on the scoreboard is not what is being graded.',
    metrics: ['wDeathsPerMin']
  },
  vision: {
    label: 'Vision',
    what: 'Vision score per minute, control wards, and wards you took off the enemy.',
    how: 'Half the grade is vision score against your counterpart and the role bar; the rest is control wards and ward takedowns.',
    watch:
      'Ward takedowns are in there because they are the half that cannot be farmed from the fountain. Raw wards placed is not scored on its own.',
    metrics: ['visionPerMin']
  },
  objectives: {
    label: 'Objectives',
    what: 'Your share of the epics your team took, whether your team took any at all, and structure damage.',
    how:
      'Weighted by macro value rather than counted: a soul drake is worth more than the first one, void grubs about a third of a drake each. ' +
      'With only one or two epics on the board the share is shrunk toward neutral, because "you were not on it" is noise at that point.',
    watch:
      'For a jungler the share axis is dropped entirely — the median jungler is present for 100% of their team’s epics, so a bar of 1.0 could only ever return exactly par. What separates junglers is how many their team got.',
    metrics: ['epicShare', 'turretDmgPerMin']
  },
  presence: {
    label: 'Presence / Participation',
    what: 'Kill participation overall, and separately after 15 minutes.',
    how:
      'The bar is rescaled by how this particular game spread its kills — a 38-kill game of solo picks compresses everyone’s number. ' +
      'Post-15 participation gets its own bar because it runs 7–22% higher than overall KP, by a different factor per role.',
    watch: 'Participation without damage is caught by Teamfight, not here. This measures being in the fights that mattered.',
    metrics: ['kp', 'lateKp']
  },
  economy: {
    label: 'Farming / Jungle farm',
    what: 'CS and gold per minute, against your counterpart and the role bar.',
    how: 'Anchored to a baseline as well as the counterpart, so a good clear is not marked down for being opposite a Karthus.',
    watch: 'Farm is the easiest thing on this list to do while contributing nothing, which is why it never weighs more than 16.',
    metrics: ['csPerMin', 'goldPerMin']
  },
  roam: {
    label: 'Roaming',
    what: 'Whether you made things happen away from your own lane — measured differently by role.',
    how:
      'For a mid laner it is kill participation plus how much of the team’s objective presence was you, which is what leaving lane actually buys. ' +
      'For a support it is takedowns away from bot lane during laning phase.',
    watch:
      'Roam *rate* is deliberately not scored anywhere — walking around the map is not an achievement, so this counts outcomes rather than movement. ' +
      'Note the detail line for a mid laner reads as participation, because for that role this is participation.',
    metrics: ['kp', 'lateKp']
  },
  tempo: {
    label: 'Tempo & map control / Wave and vision',
    what: 'For a jungler: cross-map trades, control of the enemy jungle, and the state of the lanes you actually visited.',
    how:
      'Lane state is weighted by where the jungler was, so camping a lane to a win is credited and a lane that won without them is only partly theirs. ' +
      'Counter-jungling is priced in camps, with takedowns on the enemy jungler worth about three and dying there costing about two.',
    watch:
      'This replaced a flat "how were my four lanes at 14", which was the only component in any rubric set almost entirely by other people.',
    metrics: ['jungleCs14', 'teamLaneGoldDiff14']
  },
  pressure: {
    label: 'Gank impact',
    what: 'Ganks that produced something, and lanes you left unanswered while the enemy jungler was in them.',
    how: 'Credited on outcomes. A gank that achieved nothing is not a gank that happened.',
    watch: 'The other side of it appears on the laner’s grade: pressure you took lowers your lane bar, and pressure your jungler gave raises it.',
    metrics: []
  },
  sidelane: {
    label: 'Side lane',
    what: 'Solo kills, plates, and the pressure a top laner generates away from the team.',
    how: 'Split-pushing is credited as map pressure rather than read as absence from fights.',
    watch: 'Plates are split by phase — since 2026 they persist on second and third turrets, so the raw count is no longer a laning signal.',
    metrics: ['platesEarly', 'platesLate']
  },
  structures: {
    label: 'Objectives (ADC)',
    what: 'Turret damage and structure takedowns.',
    how: 'Graded against the role bar as well as the counterpart.',
    watch: 'An inhibitor is worth more than the tower in front of it: it opens super minions and is usually what ends the game.',
    metrics: ['turretDmgPerMin']
  },
  utility: {
    label: 'Utility',
    what: 'Crowd control and healing/shielding — whichever your champion is built for.',
    how:
      'Each axis is graded against what a support who *chose* that axis does, then the axis you specialised in is the one that counts. ' +
      'The comparison to the enemy support is made on their specialist score too, not on the same axis: an Alistar’s CC against a Soraka’s healing.',
    watch:
      'Never compared axis-for-axis with the enemy. An Alistar beats a Soraka on CC in every game either of them will ever play, so grading that head-to-head reads champion select rather than play.',
    metrics: ['ccScore', 'healShield']
  }
};

/** Underlying metrics. `bar` names the BASELINE field to print per role. */
export const METRICS = {
  dmgShare: {
    label: 'Damage share',
    what: 'Your share of your team’s damage to champions.',
    source: 'Riot challenges (`teamDamagePercentage`)',
    confidence: 'HIGH',
    bar: 'dmgShare',
    note: 'The bar moves with game length — a marksman with one item does a fraction of the damage they do with five, so an ADC is expected to do more of it the longer the game runs.'
  },
  tankShare: {
    label: 'Damage taken share',
    what: 'Your share of the damage your team took.',
    source: 'Riot challenges (`damageTakenOnTeamPercentage`)',
    confidence: 'HIGH',
    bar: 'tankShare',
    note: 'Good or bad depending on the role. A top laner soaking 27% is doing their job; an ADC doing the same is standing in the wrong place.'
  },
  damagePerGoldShare: {
    label: 'Resource conversion',
    what: 'Damage share divided by gold share — what you did with what you got.',
    source: 'Derived from the summary',
    confidence: 'HIGH',
    bar: 'damagePerGoldShare',
    note:
      'The anti-snowball metric. Damage share rises when you are winning because you have more items, so scoring it raw partly measures whether your team won. ' +
      'This one measures the same for winners and losers — 0.980 against 0.979 across the sample — so it is play rather than outcome. It is what separates "he was fed" from "he was carrying".'
  },
  killPerDamageShare: {
    label: 'Kill conversion',
    what: 'Kills taken as a proportion of damage done — did the damage decide anything.',
    source: 'Derived from the summary',
    confidence: 'MEDIUM',
    bar: 'killPerDamageShare',
    note:
      'Exists because damage share on its own is farmable by poking a frontline in a fight you are losing. Par differs by role because conversion is a fact about champion class first: a jungler converts at 1.24 and a top laner at 0.80, since bruisers chip where assassins execute.'
  },
  kp: {
    label: 'Kill participation',
    what: 'Share of your team’s kills you were involved in.',
    source: 'Riot challenges (`killParticipation`)',
    confidence: 'HIGH',
    bar: 'kp',
    note: 'Rescaled by how this game spread its kills, against a measured typical team average of 0.467.'
  },
  lateKp: {
    label: 'Post-15 participation',
    what: 'Kill participation after the 15-minute mark.',
    source: 'Timeline',
    confidence: 'HIGH',
    bar: 'lateKp',
    note: 'Its own bar, not a slice of the overall one: post-15 participation runs 7–22% higher than whole-game KP, by a different factor per role.'
  },
  wDeathsPerMin: {
    label: 'Weighted deaths per minute',
    what: 'Deaths per minute, each weighted by how much of it was your fault.',
    source: 'Timeline',
    confidence: 'HIGH',
    bar: 'wDeathsPerMin',
    note: 'Lower is better. A solo death deep in the enemy jungle weighs more than one in a five-man fight.'
  },
  gold14: {
    label: 'Gold at 14',
    what: 'Total gold at the end of laning phase.',
    source: 'Timeline',
    confidence: 'HIGH',
    bar: 'gold14',
    note: 'The absolute half of the lane grade. Until this existed, two laners who both farmed badly went even and both scored par.'
  },
  xp14: { label: 'Experience at 14', what: 'Total XP at the end of laning phase.', source: 'Timeline', confidence: 'HIGH', bar: 'xp14', note: 'Catches lanes lost to zoning, where the CS looks fine.' },
  goldDiff14: {
    label: 'Gold difference at 14',
    what: 'Your gold at 14 minus your counterpart’s.',
    source: 'Timeline',
    confidence: 'HIGH',
    note: 'Scaled to each role’s own spread. The 90th-percentile top lane is 2022g ahead and the 90th-percentile support lane 974g, so one scale for both would grade the same quality of lane differently by role.'
  },
  csPerMin: { label: 'CS per minute', what: 'Minions and monsters killed per minute.', source: 'Summary', confidence: 'HIGH', bar: 'csPerMin' },
  goldPerMin: { label: 'Gold per minute', what: 'Gold earned per minute.', source: 'Summary', confidence: 'HIGH', bar: 'goldPerMin' },
  visionPerMin: { label: 'Vision score per minute', what: 'Riot’s vision score, per minute.', source: 'Riot challenges', confidence: 'MEDIUM', bar: 'visionPerMin', note: 'Medium confidence: vision score rewards placing wards more than placing them usefully.' },
  epicShare: { label: 'Objective share', what: 'Your share of the epic objectives your team took, weighted by macro value.', source: 'Timeline', confidence: 'HIGH', bar: 'epicShare', note: 'Not graded for junglers — the median jungler is on 100% of them, so the bar has no headroom.' },
  turretDmgPerMin: { label: 'Turret damage per minute', what: 'Damage to structures, per minute.', source: 'Summary', confidence: 'HIGH', bar: 'turretDmgPerMin' },
  jungleCs14: { label: 'Jungle monsters at 14', what: 'Jungle monsters killed by the 14-minute mark.', source: 'Timeline', confidence: 'HIGH', bar: 'jungleCs14', note: 'Monsters, not camps — a full six-camp clear is roughly eighteen of them.' },
  teamLaneGoldDiff14: { label: 'Team lane state at 14', what: 'How far ahead or behind a team’s four lanes collectively are at 14.', source: 'Timeline', confidence: 'HIGH', note: 'What the jungler’s tempo grade is measured against, weighted by which lanes they actually visited.' },
  ccScore: { label: 'Crowd control score', what: 'Time spent crowd-controlling enemies.', source: 'Summary', confidence: 'MEDIUM', bar: 'ccScore', note: 'The bar is the 90th percentile, not the median: it is the figure for a support who chose this axis, since half of them play the other one.' },
  healShield: { label: 'Healing and shielding', what: 'Effective healing and shielding on teammates, per minute.', source: 'Riot challenges', confidence: 'HIGH', bar: 'healShield', note: 'Also a 90th-percentile bar, for the same reason as CC.' },
  platesEarly: { label: 'Plates before 14', what: 'Turret plates taken in your own lane during laning phase.', source: 'Timeline', confidence: 'MEDIUM', note: 'Time-and-lane filtered, because since 2026 plates persist and exist on second and third turrets — the raw count is no longer a laning signal.' },
  platesLate: { label: 'Plates after 14', what: 'Plates taken after laning phase.', source: 'Timeline', confidence: 'MEDIUM', note: 'Map pressure rather than lane dominance.' }
};

/** What is deliberately not measured (spec §1.4). */
// Kept short and comma-free: these get joined into a single footer line, and an
// entry containing its own comma turns that line into an unreadable list.
export const NOT_MEASURED = [
  'communication and shotcalling',
  'draft and champion select',
  'wave management beyond gold and xp',
  'whether a call was right — only whether it worked'
];

/** Every id `/explain` will answer to. */
export function explainableIds() {
  return [...Object.keys(COMPONENTS), ...Object.keys(METRICS)];
}

/** Case-insensitive lookup across both levels. */
export function lookup(id) {
  const key = String(id || '').trim().toLowerCase();
  for (const [k, v] of Object.entries(COMPONENTS)) {
    if (k.toLowerCase() === key || v.label.toLowerCase() === key) return { kind: 'component', id: k, ...v };
  }
  for (const [k, v] of Object.entries(METRICS)) {
    if (k.toLowerCase() === key || v.label.toLowerCase() === key) return { kind: 'metric', id: k, ...v };
  }
  return null;
}

/** The live bar for a metric in every role, straight out of the calibration. */
export function barsFor(metric) {
  if (!metric.bar) return null;
  const measured = new Set(calibratedRoles());
  return ROLES.map((role) => ({
    role,
    value: BASELINE[role]?.[metric.bar] ?? null,
    measured: measured.has(role)
  })).filter((r) => r.value != null);
}

/** Which components use a metric, and what they weigh in each role. */
export function usedBy(metricId) {
  const out = [];
  for (const [key, c] of Object.entries(COMPONENTS)) {
    if (!c.metrics.includes(metricId)) continue;
    const weights = ROLES.filter((r) => RUBRICS[r][key] != null).map((r) => ({ role: r, weight: RUBRICS[r][key] }));
    if (weights.length) out.push({ key, label: c.label, weights });
  }
  return out;
}
