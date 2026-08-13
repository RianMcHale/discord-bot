import { db } from './storage.js';
import { finalScoreWithVotes } from './scoring/index.js';

function avgVoteFor(matchId, discordId) {
  const votes = db.votesForGame(matchId);
  const ratings = Object.values(votes)
    .map((byTarget) => byTarget[discordId])
    .filter((r) => typeof r === 'number');
  if (ratings.length === 0) return null;
  return ratings.reduce((a, b) => a + b, 0) / ratings.length;
}

/**
 * Returns { discordId, gamesPlayed, rollingAverage, recentScores: number[] }
 * sorted ascending by rollingAverage (worst first), for the given window size.
 * Players with zero scored games are excluded — there's nothing to judge yet.
 */
export function computeRollingStats(windowSize) {
  const players = db.allPlayers();
  const stats = players.map((player) => {
    const games = db.gamesForPlayer(player.discordId, windowSize); // most recent first
    const finalScores = games.map((g) => {
      const s = g.scores[player.discordId];
      const avgVote = avgVoteFor(g.matchId, player.discordId);
      return finalScoreWithVotes(s.composite, avgVote);
    });
    const rollingAverage =
      finalScores.length > 0 ? Math.round((finalScores.reduce((a, b) => a + b, 0) / finalScores.length) * 10) / 10 : null;

    return {
      discordId: player.discordId,
      riotName: `${player.riotGameName}#${player.riotTagLine}`,
      gamesPlayed: finalScores.length,
      rollingAverage,
      recentScores: finalScores
    };
  });

  return stats
    .filter((s) => s.gamesPlayed > 0)
    .sort((a, b) => a.rollingAverage - b.rollingAverage);
}
