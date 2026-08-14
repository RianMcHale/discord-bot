import { db } from './storage.js';
import { finalScoreWithVotes } from './scoring/index.js';

/** Average teammate vote for a player in one game, or null if nobody voted. */
function avgVoteFor(votesForMatch, discordId) {
  const ratings = Object.values(votesForMatch || {})
    .map((byTarget) => byTarget[discordId])
    .filter((r) => typeof r === 'number');
  if (ratings.length === 0) return null;
  return ratings.reduce((a, b) => a + b, 0) / ratings.length;
}

/** A player's stored score for one game, with any teammate votes blended in. */
function finalScore(game, discordId, allVotes) {
  const s = game.scores[discordId];
  return finalScoreWithVotes(s.composite, avgVoteFor(allVotes[game.matchId], discordId));
}

/**
 * Returns { discordId, gamesPlayed, rollingAverage, recentScores: number[] }
 * sorted ascending by rollingAverage (worst first), for the given window size.
 * Players with zero scored games are excluded — there's nothing to judge yet.
 */
export function computeRollingStats(windowSize) {
  const allVotes = db.allVotes();
  const players = db.allPlayers();

  const stats = players.map((player) => {
    const games = db.gamesForPlayer(player.discordId, windowSize); // most recent first
    const finalScores = games.map((g) => finalScore(g, player.discordId, allVotes));
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

  return stats.filter((s) => s.gamesPlayed > 0).sort((a, b) => a.rollingAverage - b.rollingAverage);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

/**
 * Career stats across every stored game, best average first.
 *
 * Distinct from computeRollingStats in what it's for: the rolling average
 * answers "who is playing badly right now" for the bench call, this answers
 * "who is actually good, and at what". The per-role split is the interesting
 * part — scores are role-anchored, so a player's Mid average and their Jungle
 * average are directly comparable and will often disagree.
 *
 * @param {number} formWindow - how many recent games count as "current form"
 */
export function computeCareerStats(formWindow = 5) {
  const allVotes = db.allVotes();
  const games = db.allGames(); // ascending by playedAt
  const players = db.allPlayers();

  const acc = new Map(
    players.map((p) => [
      p.discordId,
      {
        discordId: p.discordId,
        riotName: `${p.riotGameName}#${p.riotTagLine}`,
        displayName: p.riotGameName,
        scores: [],
        byRole: new Map(),
        wins: 0,
        losses: 0,
        benched: 0,
        firstPlayed: null,
        lastPlayed: null
      }
    ])
  );

  let legacyGames = 0; // games scored before the role-based rewrite

  for (const game of games) {
    const entries = Object.keys(game.scores)
      .filter((id) => acc.has(id))
      .map((id) => ({ id, score: finalScore(game, id, allVotes), stored: game.scores[id] }));
    if (entries.length === 0) continue;
    if (!game.dataQuality) legacyGames += 1;

    // Whoever finished lowest in a game they shared counts as benched for it.
    // Needs at least two tracked players — being "worst" of one is meaningless.
    const lowest = entries.length > 1 ? entries.reduce((a, b) => (b.score < a.score ? b : a)) : null;

    for (const { id, score, stored } of entries) {
      const a = acc.get(id);
      a.scores.push(score);
      if (stored.win) a.wins += 1;
      else a.losses += 1;
      if (lowest && id === lowest.id) a.benched += 1;
      if (a.firstPlayed === null) a.firstPlayed = game.playedAt;
      a.lastPlayed = game.playedAt;

      const role = stored.role || 'UNKNOWN';
      if (!a.byRole.has(role)) a.byRole.set(role, []);
      a.byRole.get(role).push(score);
    }
  }

  const stats = [...acc.values()]
    .filter((a) => a.scores.length > 0)
    .map((a) => {
      const average = mean(a.scores);
      const form = mean(a.scores.slice(-formWindow));
      return {
        discordId: a.discordId,
        riotName: a.riotName,
        displayName: a.displayName,
        gamesPlayed: a.scores.length,
        average: round1(average),
        best: round1(Math.max(...a.scores)),
        worst: round1(Math.min(...a.scores)),
        wins: a.wins,
        losses: a.losses,
        winRate: Math.round((a.wins / a.scores.length) * 100),
        benched: a.benched,
        // Only meaningful once there's history to compare the recent window against.
        form: a.scores.length > formWindow ? round1(form) : null,
        formDelta: a.scores.length > formWindow ? round1(form - average) : null,
        firstPlayed: a.firstPlayed,
        lastPlayed: a.lastPlayed,
        byRole: [...a.byRole.entries()]
          .map(([role, scores]) => ({ role, games: scores.length, average: round1(mean(scores)) }))
          .sort((x, y) => y.games - x.games || y.average - x.average)
      };
    })
    .sort((a, b) => b.average - a.average);

  return {
    stats,
    totalGames: games.length,
    legacyGames,
    firstPlayed: games.length ? games[0].playedAt : null,
    lastPlayed: games.length ? games[games.length - 1].playedAt : null
  };
}
