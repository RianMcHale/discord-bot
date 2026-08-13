// Scoring philosophy (see conversation for the full rationale):
//
// Comparing raw stats across roles is meaningless — a support's KDA and an ADC's KDA
// don't mean the same thing. So instead of comparing everyone against fixed thresholds,
// we min-max normalize each metric across ALL 10 PLAYERS IN THE MATCH (not just your
// tracked squad). This matters: with only 2-6 tracked players in a given game, min-max
// normalization against that tiny group exaggerates small raw differences into fake
// extremes — someone can look like a "100/100 kill participation" player just for
// edging out the 2-3 other tracked players who happened to play that game, even though
// their actual share of team kills was unremarkable. Normalizing against the full
// 10-player lobby gives a much more realistic, stable spread to compare against.
//
// Objective weights (sum to 0.85, leaving 0.15 for the human "impact" vote):
//   Kill participation              0.15
//   Damage / gold efficiency        0.20
//   Vision + objective involvement  0.15
//   Deaths (inverted, fewer better) 0.35
//
// Deaths carry the heaviest weight on purpose — going 2/8 should hurt a lot more than
// a strong damage or kill-participation stat can offset, especially at extremes.
//
// A subjective teammate vote (1-5 stars, /vote) can fill the remaining 0.15 — this
// exists because stats can't see "threw the fight by overextending" or "made the call
// that won the game." If nobody votes, the objective composite is used as-is
// (re-normalized to 100).

const WEIGHTS = {
  killParticipation: 0.15,
  dmgGoldEfficiency: 0.20,
  visionObjective: 0.15,
  deathsInverse: 0.35
};
const OBJECTIVE_WEIGHT_SUM = Object.values(WEIGHTS).reduce((a, b) => a + b, 0); // 0.85
const VOTE_WEIGHT = 1 - OBJECTIVE_WEIGHT_SUM; // 0.15

function minMax(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 100); // everyone tied -> nobody penalized
  return values.map((v) => ((v - min) / (max - min)) * 100);
}

function rawMetricsForParticipant(p, gameDurationSeconds) {
  const minutes = Math.max(gameDurationSeconds / 60, 1);
  const c = p.challenges || {};

  // Riot's own killParticipation is already relative to that player's TEAM total
  // kills (kills+assists)/teamKills — i.e. it already accounts for the whole game's
  // kill count, not just your tracked squad. We only re-scale it below for spread.
  const killParticipation =
    typeof c.killParticipation === 'number'
      ? c.killParticipation
      : (p.kills + p.assists) / Math.max(p.teamTotalKillsInGame || p.kills + p.assists || 1, 1);

  const dmgGoldEfficiency = p.totalDamageDealtToChampions / Math.max(p.goldEarned, 1);

  const visionPerMin = typeof c.visionScorePerMinute === 'number' ? c.visionScorePerMinute : p.visionScore / minutes;

  const objectiveTakedowns =
    (c.turretTakedowns || 0) + (c.dragonTakedowns || 0) + (c.baronTakedowns || 0) + (c.riftHeraldTakedowns || 0);

  const visionObjectiveRaw = visionPerMin + objectiveTakedowns; // combined, normalized together below

  const deathsPerMin = p.deaths / minutes;

  return {
    killParticipation,
    dmgGoldEfficiency,
    visionObjectiveRaw,
    deathsPerMin,
    kda: `${p.kills}/${p.deaths}/${p.assists}`,
    role: p.teamPosition || p.individualPosition || 'UNKNOWN',
    champion: p.championName,
    teamId: p.teamId,
    win: p.win
  };
}

/**
 * Scores EVERY player in the match (both teams), normalized against the full
 * 10-player lobby. Callers typically filter this down to their tracked squad, but
 * the full result is returned so callers can also show enemy-team context (e.g. an
 * "enemy team scores" summary) without a second pass over the match data.
 * @param {object} match - raw match-v5 "get match" response
 * @param {string[]} trackedPuuids - puuids of players in your rotation who played this game
 * @returns {Record<string, {composite:number, breakdown:object, role:string, champion:string, teamId:number, kda:string, win:boolean, isTracked:boolean}>}
 */
export function scoreMatch(match, trackedPuuids) {
  const trackedInMatch = match.info.participants.filter((p) => trackedPuuids.includes(p.puuid));
  if (trackedInMatch.length < 2) {
    throw new Error('Need at least 2 tracked players in the match to score it relatively.');
  }

  const gameDurationSeconds = match.info.gameDuration;

  // Compute + normalize against ALL 10 participants for a realistic spread.
  const allMetrics = match.info.participants.map((p) => ({
    puuid: p.puuid,
    ...rawMetricsForParticipant(p, gameDurationSeconds)
  }));

  const killPartScores = minMax(allMetrics.map((m) => m.killParticipation));
  const dmgGoldScores = minMax(allMetrics.map((m) => m.dmgGoldEfficiency));
  const visionObjScores = minMax(allMetrics.map((m) => m.visionObjectiveRaw));
  const deathsScoresRaw = minMax(allMetrics.map((m) => m.deathsPerMin));
  const deathsInverseScores = deathsScoresRaw.map((s) => 100 - s); // fewer deaths -> higher score

  const result = {};
  allMetrics.forEach((m, i) => {
    const objectiveComposite =
      (killPartScores[i] * WEIGHTS.killParticipation +
        dmgGoldScores[i] * WEIGHTS.dmgGoldEfficiency +
        visionObjScores[i] * WEIGHTS.visionObjective +
        deathsInverseScores[i] * WEIGHTS.deathsInverse) /
      OBJECTIVE_WEIGHT_SUM;

    result[m.puuid] = {
      composite: Math.round(objectiveComposite * 10) / 10, // objective-only, 0-100, before votes
      breakdown: {
        killParticipation: Math.round(killPartScores[i] * 10) / 10,
        dmgGoldEfficiency: Math.round(dmgGoldScores[i] * 10) / 10,
        visionObjective: Math.round(visionObjScores[i] * 10) / 10,
        deathsInverse: Math.round(deathsInverseScores[i] * 10) / 10
      },
      role: m.role,
      champion: m.champion,
      teamId: m.teamId,
      kda: m.kda,
      win: m.win,
      isTracked: trackedPuuids.includes(m.puuid)
    };
  });

  return result;
}

/**
 * Combines a player's objective composite with an average teammate vote (1-5 stars).
 * If no votes exist yet, returns the objective composite unchanged.
 */
export function finalScoreWithVotes(objectiveComposite, avgVote /* 1-5 or null */) {
  if (avgVote === null || avgVote === undefined) return objectiveComposite;
  const voteAsScore = ((avgVote - 1) / 4) * 100; // map 1-5 -> 0-100
  return Math.round((objectiveComposite * OBJECTIVE_WEIGHT_SUM + voteAsScore * VOTE_WEIGHT) * 10) / 10;
}

export const WEIGHT_INFO = { ...WEIGHTS, voteWeight: VOTE_WEIGHT };