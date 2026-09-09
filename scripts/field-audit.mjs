// Reconciles every field the audit spec names against what the probe actually
// saw (§14 Phase 0). Emits docs/field-audit.md.
//
// The spec is explicit that its field names are hypotheses. This is where they
// get confirmed, renamed, or struck out — and nothing downstream should be
// written against a field that appears here as MISSING.
//
//   node scripts/field-audit.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(__dirname, '..', 'docs');
const observed = JSON.parse(fs.readFileSync(path.join(DOCS, 'schema-observed.json'), 'utf-8'));

// Every `challenges` field named anywhere in the spec's §3.3 and §4.
const SPEC_CHALLENGES = {
  Laning: ['laneMinionsFirst10Minutes', 'jungleCsBefore10Minutes', 'maxCsAdvantageOnLaneOpponent', 'maxLevelLeadLaneOpponent', 'laningPhaseGoldExpAdvantage', 'earlyLaningPhaseGoldExpAdvantage', 'takedownsFirstXMinutes', 'maxKillDeficit'],
  'Combat quality': ['soloKills', 'quickSoloKills', 'outnumberedKills', 'takedownsAfterGainingLevelAdvantage', 'killsNearEnemyTurret', 'killsUnderOwnTurret', 'deathsByEnemyChamps', 'skillshotsHit', 'skillshotsDodged', 'dodgeSkillShotsSmallWindow', 'landSkillShotsEarlyGame', 'abilityUses', 'enemyChampionImmobilizations', 'immobilizeAndKillWithAlly', 'pickKillWithAlly', 'killedChampTookFullTeamDamageSurvived', 'survivedThreeImmobilizesInFight', 'tookLargeDamageSurvived'],
  Objectives: ['dragonTakedowns', 'earliestDragonTakedown', 'baronTakedowns', 'earliestBaron', 'riftHeraldTakedowns', 'epicMonsterSteals', 'epicMonsterStolenWithoutSmite', 'epicMonsterKillsNearEnemyJungler', 'epicMonsterKillsWithin30SecondsOfSpawn', 'junglerTakedownsNearDamagedEpicMonster', 'teamBaronKills', 'teamElderDragonKills', 'teamRiftHeraldKills'],
  Structures: ['turretPlatesTaken', 'turretTakedowns', 'kTurretsDestroyedBeforePlatesFall', 'quickFirstTurret', 'takedownOnFirstTurret', 'firstTurretKilled', 'turretsTakenWithRiftHerald', 'multiTurretRiftHeraldCount', 'outerTurretExecutesBefore10Minutes'],
  Jungle: ['initialCrabCount', 'initialBuffCount', 'scuttleCrabKills', 'buffsStolen', 'enemyJungleMonsterKills', 'alliedJungleMonsterKills', 'moreEnemyJungleThanOpponent', 'killsOnLanersEarlyJungleAsJungler', 'takedownsBeforeJungleMinionSpawn'],
  'Laner-side jungle': ['getTakedownsInAllLanesEarlyJungleAsLaner', 'killsOnOtherLanesEarlyJungleAsLaner'],
  Vision: ['controlWardsPlaced', 'stealthWardsPlaced', 'controlWardTimeCoverageInRiverOrEnemyHalf', 'wardTakedowns', 'wardTakedownsBefore20M', 'wardsGuarded', 'visionScoreAdvantageLaneOpponent', 'visionScorePerMinute', 'twoWardsOneSweeperCount'],
  'Support/enchanter': ['effectiveHealAndShielding', 'saveAllyFromDeath', 'completeSupportQuestInTime'],
  'Rates and shares': ['kda', 'killParticipation', 'teamDamagePercentage', 'damageTakenOnTeamPercentage', 'damagePerMinute', 'goldPerMinute', 'gameLength', 'bountyGold', 'legendaryCount', 'fastestLegendary', 'highestChampionDamage'],
  Meta: ['playedChampSelectPosition', 'teleportTakedowns', 'unseenRecalls', 'hadOpenNexus', 'lostAnInhibitor', 'acesBefore15Minutes', 'perfectGame']
};

// Top-level participant fields named in §3.2.
const SPEC_PARTICIPANT = `kills deaths assists goldEarned goldSpent champExperience champLevel
totalMinionsKilled neutralMinionsKilled totalAllyJungleMinionsKilled totalEnemyJungleMinionsKilled
totalDamageDealtToChampions totalDamageTaken damageSelfMitigated
totalDamageShieldedOnTeammates totalHealsOnTeammates totalUnitsHealed
damageDealtToTurrets damageDealtToObjectives damageDealtToBuildings
timeCCingOthers totalTimeCCDealt totalTimeSpentDead longestTimeSpentLiving
visionScore wardsPlaced wardsKilled detectorWardsPlaced visionWardsBoughtInGame
turretTakedowns turretKills turretsLost inhibitorTakedowns inhibitorsLost
objectivesStolen objectivesStolenAssists dragonKills baronKills
firstBloodKill firstBloodAssist firstTowerKill firstTowerAssist
teamPosition individualPosition lane role
bountyLevel timePlayed
gameEndedInSurrender gameEndedInEarlySurrender teamEarlySurrendered`.split(/\s+/).filter(Boolean);

// Timeline event types named in §3.4.
const SPEC_EVENTS = ['PAUSE_END', 'SKILL_LEVEL_UP', 'LEVEL_UP', 'ITEM_PURCHASED', 'ITEM_SOLD', 'ITEM_DESTROYED', 'ITEM_UNDO', 'WARD_PLACED', 'WARD_KILL', 'CHAMPION_KILL', 'CHAMPION_SPECIAL_KILL', 'BUILDING_KILL', 'TURRET_PLATE_DESTROYED', 'ELITE_MONSTER_KILL', 'DRAGON_SOUL_GIVEN', 'OBJECTIVE_BOUNTY_PRESTART', 'OBJECTIVE_BOUNTY_FINISH', 'CHAMPION_TRANSFORM', 'GAME_END'];

// Per-frame fields named in §3.4.
const SPEC_FRAME = ['position', 'currentGold', 'totalGold', 'goldPerSecond', 'minionsKilled', 'jungleMinionsKilled', 'level', 'xp', 'timeEnemySpentControlled', 'championStats', 'damageStats'];

const NULL_HEAVY = 0.05; // spec §3.5: flag anything above a 5% null rate

const rows = [];
const missing = [];
const nullHeavy = [];

function check(group, name, table, kind) {
  const e = table[name];
  if (!e) {
    missing.push({ group, name, kind });
    return;
  }
  if (e.missingRate > NULL_HEAVY || e.zeroOrNullRate > 0.95) {
    nullHeavy.push({ group, name, kind, missingRate: e.missingRate, zeroOrNullRate: e.zeroOrNullRate });
  }
  rows.push({ group, name, kind, ...e });
}

for (const [group, names] of Object.entries(SPEC_CHALLENGES)) {
  for (const n of names) check(group, n, observed.challenges, 'challenges');
}
for (const n of SPEC_PARTICIPANT) check('Participant (§3.2)', n, observed.participantFields, 'participant');
for (const n of SPEC_FRAME) check('Frame (§3.4)', n, observed.participantFrameKeys, 'frame');

const eventsMissing = SPEC_EVENTS.filter((t) => !observed.eventTypes[t]);
const eventsExtra = Object.keys(observed.eventTypes).filter((t) => !SPEC_EVENTS.includes(t));

const specNamed = new Set([...Object.values(SPEC_CHALLENGES).flat()]);
const challengesUnnamed = Object.keys(observed.challenges).filter((k) => !specNamed.has(k));

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const L = [];
L.push('# Field audit — spec §3/§4 vs observed payloads');
L.push('');
L.push('Generated by `scripts/field-audit.mjs` from `docs/schema-observed.json`.');
L.push('Regenerate on every patch bump and diff (spec §3.5).');
L.push('');
L.push('| | |');
L.push('|---|---|');
L.push(`| Matches probed | ${observed.sample.matchesProbed} |`);
L.push(`| Participant rows | ${observed.sample.participantRows} |`);
L.push(`| Timelines available | ${observed.sample.matchesWithTimeline} |`);
L.push(`| \`challenges\` missing rate | ${pct(observed.sample.challengesMissingRate)} |`);
L.push(`| Patches in sample | ${Object.keys(observed.gameVersions).join(', ')} |`);
L.push(`| Queues in sample | ${Object.keys(observed.queueIds).join(', ')} |`);
L.push('');

L.push('## Verdict summary');
L.push('');
L.push(`- **Confirmed:** ${rows.length} of ${rows.length + missing.length} spec-named fields present.`);
L.push(`- **Missing:** ${missing.length} — listed below. Any metric depending on one of these cannot be built as specified.`);
L.push(`- **Null-heavy (>${pct(NULL_HEAVY)} absent, or ≥95% zero):** ${nullHeavy.length}.`);
L.push(`- **Timeline event types:** ${eventsMissing.length} named but unseen, ${eventsExtra.length} seen but unnamed.`);
L.push(`- **\`challenges\` keys present but never named by the spec:** ${challengesUnnamed.length}.`);
L.push('');

if (missing.length) {
  L.push('## MISSING — named by the spec, not present in any payload');
  L.push('');
  L.push('| Field | Group | Kind |');
  L.push('|---|---|---|');
  for (const m of missing) L.push(`| \`${m.name}\` | ${m.group} | ${m.kind} |`);
  L.push('');
}

if (nullHeavy.length) {
  L.push('## NULL-HEAVY — present but thin');
  L.push('');
  L.push('A field that is absent or zero in nearly every row cannot carry weight. Zero is');
  L.push('legitimate for rare events (steals, pentakills); it is not for a metric meant to');
  L.push('separate players every game.');
  L.push('');
  L.push('| Field | Group | Absent | Zero/false when present |');
  L.push('|---|---|---|---|');
  for (const n of nullHeavy.sort((a, b) => b.zeroOrNullRate - a.zeroOrNullRate)) {
    L.push(`| \`${n.name}\` | ${n.group} | ${pct(n.missingRate)} | ${pct(n.zeroOrNullRate)} |`);
  }
  L.push('');
}

L.push('## Timeline events');
L.push('');
L.push('| Event | Seen | Note |');
L.push('|---|---|---|');
for (const t of SPEC_EVENTS) {
  const r = observed.eventTypes[t];
  L.push(`| \`${t}\` | ${r ? r.count : 0} | ${r ? '' : '**not seen in sample**'} |`);
}
for (const t of eventsExtra) L.push(`| \`${t}\` | ${observed.eventTypes[t].count} | seen but not named by the spec |`);
L.push('');

L.push('## Observed enums');
L.push('');
for (const [k, v] of Object.entries(observed.enums)) {
  if (!Object.keys(v).length) continue;
  L.push(`- **\`${k}\`** — ${Object.entries(v).map(([a, b]) => `\`${a}\` (${b})`).join(', ')}`);
}
L.push('');

L.push('## Patch facts checked against spec §F8');
L.push('');
const pf = observed.patchFacts;
L.push('| Spec claim | Observed | Verdict |');
L.push('|---|---|---|');
L.push(`| Atakhan removed | ${pf.atakhanEvents} ATAKHAN events in ${observed.sample.matchesProbed} matches | ${pf.atakhanEvents === 0 ? '**supported**' : 'contradicted'} |`);
L.push(`| Baron returned to a 20:00 spawn | earliest baron kill at ${(pf.baronFirstSpawnMs / 60000).toFixed(1)} min (${pf.baronKillsSeen} kills seen) | ${pf.baronFirstSpawnMs > 1_150_000 && pf.baronFirstSpawnMs < 1_500_000 ? '**supported**' : 'check'} |`);
L.push(`| Plates persist past 14:00 and exist on T2/T3 | ${pf.turretPlateEventsAfter14Min} of ${pf.turretPlateEvents} plate events (${pct(pf.turretPlateEventsAfter14Min / pf.turretPlateEvents)}) after 14:00 | ${pf.turretPlateEventsAfter14Min / pf.turretPlateEvents > 0.3 ? '**supported**' : 'contradicted'} |`);
L.push(`| Void grubs present | ${pf.hordeEvents} HORDE events | ${pf.hordeEvents > 0 ? '**supported**' : 'not seen'} |`);
L.push(`| Frame interval 60000ms | ${Object.keys(observed.frameIntervals).join(', ')} | ${observed.frameIntervals['60000'] ? '**supported**' : 'differs'} |`);
L.push('');

L.push('## `challenges` keys present but unnamed by the spec');
L.push('');
L.push('Not necessarily useful — most are mode-specific or trivia — but the spec claims to');
L.push('have surveyed this surface, so the gap is worth recording.');
L.push('');
L.push(challengesUnnamed.map((k) => `\`${k}\``).join(', '));
L.push('');

fs.writeFileSync(path.join(DOCS, 'field-audit.md'), L.join('\n'));
console.log(`Wrote docs/field-audit.md`);
console.log(`  confirmed ${rows.length}, missing ${missing.length}, null-heavy ${nullHeavy.length}`);
console.log(`  events: ${eventsMissing.length} unseen, ${eventsExtra.length} unnamed`);
console.log(`  unnamed challenges keys: ${challengesUnnamed.length}`);
