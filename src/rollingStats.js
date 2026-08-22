import { db } from './storage.js';

/** A player's score for one game. The composite is the whole score — no blending. */
function scoreOf(game, discordId) {
  return game.scores[discordId].composite;
}

/**
 * Recent form, over each player's OWN last `windowSize` games — not the squad's.
 * A player who sat out three of the last ten is still measured across ten of
 * their own, so nobody is judged on a shorter record than everyone else.
 *
 * Split into `ranked` and `provisional` around `minGames`: a rolling average
 * over one or two games is noise, and `/worst` benches people on this.
 *
 * @returns {{ranked: object[], provisional: object[], minGames: number}}
 *   `ranked` is sorted ascending (worst first); `provisional` is sorted by how
 *   close each player is to qualifying.
 */
export function computeRollingStats(windowSize, { minGames = 1 } = {}) {
  const players = db.allPlayers();

  const stats = players
    .map((player) => {
      const games = db.gamesForPlayer(player.discordId, windowSize); // most recent first
      const scores = games.map((g) => scoreOf(g, player.discordId));
      const rollingAverage =
        scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;

      return {
        discordId: player.discordId,
        riotName: `${player.riotGameName}#${player.riotTagLine}`,
        displayName: player.riotGameName,
        gamesPlayed: scores.length,
        rollingAverage,
        recentScores: scores,
        // What they've been repeatedly bad at over this window — the reason
        // behind the number, which is what a bench call has to justify.
        byComponent: aggregateComponents(games, player.discordId)
      };
    })
    // Players with zero scored games are excluded entirely — there is nothing to
    // judge yet, not even provisionally.
    .filter((s) => s.gamesPlayed > 0);

  return {
    minGames,
    ranked: stats.filter((s) => s.gamesPlayed >= minGames).sort((a, b) => a.rollingAverage - b.rollingAverage),
    provisional: stats.filter((s) => s.gamesPlayed < minGames).sort((a, b) => b.gamesPlayed - a.gamesPlayed)
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

// Below this a component is a real weakness rather than a slightly-off game.
// 50 is "did your job", so 45 is a clear miss without being alarmist.
const WEAK_SCORE = 45;
// A component needs this many games before "consistently weak" means anything.
const MIN_COMPONENT_GAMES = 3;

/**
 * Averages each rubric component across a set of games, worst first.
 *
 * Every scored game already stores all six component scores per player, and
 * until now nothing read them except the single-match card. Aggregated, they
 * answer the question a bench call actually raises: not "who is worst" but
 * "what is this person doing wrong, repeatedly".
 *
 * Components are keyed rather than labelled because the label changes by role —
 * an ADC's death component is called Positioning — but the key and the 50 anchor
 * are the same, so the average holds across a player who has filled two roles.
 */
export function aggregateComponents(games, discordId) {
  const acc = new Map();

  for (const game of games) {
    for (const c of game.scores[discordId]?.components ?? []) {
      if (!Number.isFinite(c.score)) continue; // dropped for missing timeline data
      if (!acc.has(c.key)) acc.set(c.key, { key: c.key, labels: new Map(), scores: [] });
      const entry = acc.get(c.key);
      entry.scores.push(c.score);
      entry.labels.set(c.label, (entry.labels.get(c.label) ?? 0) + 1);
    }
  }

  return [...acc.values()]
    .map((e) => ({
      key: e.key,
      // The label this player saw most often, so a mostly-ADC player reads
      // "Positioning" rather than "Deaths".
      label: [...e.labels.entries()].sort((a, b) => b[1] - a[1])[0][0],
      games: e.scores.length,
      average: round1(mean(e.scores)),
      weakGames: e.scores.filter((s) => s < WEAK_SCORE).length,
      reliable: e.scores.length >= MIN_COMPONENT_GAMES
    }))
    .sort((a, b) => a.average - b.average); // worst first: that's what's being asked
}

// How many games of "prior belief" a rating is anchored against. A raw average
// isn't a leaderboard — it rewards whoever has played least, and one good game
// outranks five decent ones. Blending each average with a prior fixes that
// without a minimum-games cutoff that would hide people entirely: the
// correction simply fades out as someone plays.
//
// Career ratings are pulled toward the squad's own average, which is the
// empirically right prior for "a player we know nothing about". Role ratings are
// pulled toward that player's own rating instead — the best guess for how
// someone performs in a role they've barely played is how they perform overall.
const PRIOR_GAMES = 5;
const ROLE_PRIOR_GAMES = 3;

function shrink(average, games, prior, priorGames) {
  if (average === null || prior === null) return average;
  return (average * games + prior * priorGames) / (games + priorGames);
}

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
        games: [],
        byRole: new Map(),
        byChampion: new Map(),
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
      .map((id) => ({ id, score: scoreOf(game, id), stored: game.scores[id] }));
    if (entries.length === 0) continue;
    if (!game.dataQuality) legacyGames += 1;

    // Whoever finished lowest in a game they shared counts as benched for it.
    // Needs at least two tracked players — being "worst" of one is meaningless.
    const lowest = entries.length > 1 ? entries.reduce((a, b) => (b.score < a.score ? b : a)) : null;

    for (const { id, score, stored } of entries) {
      const a = acc.get(id);
      a.scores.push({ score, playedAt: game.playedAt, matchId: game.matchId, role: stored.role, win: stored.win });
      a.games.push(game);
      if (stored.win) a.wins += 1;
      else a.losses += 1;
      if (lowest && id === lowest.id) a.benched += 1;
      if (a.firstPlayed === null) a.firstPlayed = game.playedAt;
      a.lastPlayed = game.playedAt;

      const role = stored.role || 'UNKNOWN';
      if (!a.byRole.has(role)) a.byRole.set(role, []);
      a.byRole.get(role).push(score);

      const champ = stored.champion || 'Unknown';
      if (!a.byChampion.has(champ)) a.byChampion.set(champ, { scores: [], wins: 0 });
      a.byChampion.get(champ).scores.push(score);
      if (stored.win) a.byChampion.get(champ).wins += 1;
    }
  }

  // The squad's own average across every game played, weighted by games — the
  // prior every individual rating is anchored against.
  const played = [...acc.values()].flatMap((a) => a.scores.map((s) => s.score));
  const squadMean = mean(played);

  const stats = [...acc.values()]
    .filter((a) => a.scores.length > 0)
    .map((a) => {
      const values = a.scores.map((s) => s.score);
      const average = mean(values);
      const rating = shrink(average, values.length, squadMean, PRIOR_GAMES);
      const form = mean(values.slice(-formWindow));
      const bestGame = a.scores.reduce((x, y) => (y.score > x.score ? y : x));
      const worstGame = a.scores.reduce((x, y) => (y.score < x.score ? y : x));

      return {
        // What the leaderboard ranks and displays. `average` stays the raw
        // arithmetic mean for anything that needs the unadjusted figure.
        rating: round1(rating),
        discordId: a.discordId,
        riotName: a.riotName,
        displayName: a.displayName,
        gamesPlayed: values.length,
        average: round1(average),
        best: round1(bestGame.score),
        worst: round1(worstGame.score),
        bestGame,
        worstGame,
        wins: a.wins,
        losses: a.losses,
        winRate: Math.round((a.wins / values.length) * 100),
        benched: a.benched,
        // Only meaningful once there's history to compare the recent window against.
        form: values.length > formWindow ? round1(form) : null,
        formDelta: values.length > formWindow ? round1(form - average) : null,
        firstPlayed: a.firstPlayed,
        lastPlayed: a.lastPlayed,
        // Most recent first, for sparklines and recent-form displays.
        history: [...a.scores].reverse(),
        // Averaged across every game, so a persistent weakness separates itself
        // from one bad night.
        byComponent: aggregateComponents(a.games, a.discordId),
        byRole: [...a.byRole.entries()]
          .map(([role, scores]) => ({
            role,
            games: scores.length,
            average: round1(mean(scores)),
            // Anchored to this player's own rating, so one strong game in a role
            // can't outrank five solid ones when picking who plays where.
            rating: round1(shrink(mean(scores), scores.length, rating, ROLE_PRIOR_GAMES))
          }))
          .sort((x, y) => y.games - x.games || y.rating - x.rating),
        byChampion: [...a.byChampion.entries()]
          .map(([champion, c]) => ({
            champion,
            games: c.scores.length,
            average: round1(mean(c.scores)),
            wins: c.wins
          }))
          .sort((x, y) => y.games - x.games || y.average - x.average)
      };
    })
    .sort((a, b) => b.rating - a.rating);

  return {
    stats,
    squadMean: round1(squadMean),
    totalGames: games.length,
    legacyGames,
    firstPlayed: games.length ? games[0].playedAt : null,
    lastPlayed: games.length ? games[games.length - 1].playedAt : null
  };
}
