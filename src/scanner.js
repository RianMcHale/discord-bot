// Finds and scores new shared matches.
//
// Shared by /fetchgame and the background watcher so both behave identically.
//
// The important behaviour here is the skip cache. A match with fewer than two
// tracked players can never be scored, but without remembering that, every solo
// queue game any player has ever played gets re-fetched from Riot on every scan
// — six players with a lookback of five is up to thirty match fetches a run,
// nearly all of them repeats of the same rejections. On a development key
// (100 requests / 2 minutes) that rate-limits after a few runs.

import { riot } from './riotApi.js';
import { db } from './storage.js';
import { scoreMatch } from './scoring/index.js';

/**
 * Recent match ids across EVERY registered player, not just one "anchor" —
 * otherwise a game is missed entirely whenever that one anchor player is the
 * one sitting out the rotation for that match.
 */
async function collectCandidateIds(api, players, lookback) {
  const idSet = new Set();
  for (const player of players) {
    try {
      const ids = await api.getRecentMatchIds(player.puuid, lookback);
      ids.forEach((id) => idSet.add(id));
    } catch (err) {
      console.error(`Failed to fetch match history for ${player.riotGameName}#${player.riotTagLine}:`, err.message);
    }
  }
  return [...idSet];
}

/**
 * @param {object} opts
 * @param {number} opts.lookback   recent matches to check per player
 * @param {object} opts.api        Riot client; injectable so tests need no network
 * @param {number} opts.maxToScore cap per run, so a large backlog doesn't blow
 *                                 the rate limit or Discord's 10-embed message limit
 * @returns {Promise<{scored: object[], remaining: number, checked: number, cached: number, players: object[]}>}
 *   `scored` is oldest-first so a backlog reads in the order it was played.
 */
export async function scanForNewGames({ lookback = 5, maxToScore = 5, api = riot } = {}) {
  const players = db.allPlayers();
  if (players.length < 2) {
    return { scored: [], remaining: 0, checked: 0, cached: 0, players, tooFewPlayers: true };
  }

  const rosterCount = players.length;
  const trackedPuuids = players.map((p) => p.puuid);
  const nameByDiscordId = Object.fromEntries(players.map((p) => [p.discordId, p.riotGameName]));
  const playerByPuuid = Object.fromEntries(players.map((p) => [p.puuid, p]));

  const candidateIds = await collectCandidateIds(api, players, lookback);

  // Anything already scored, or already rejected under this same roster, costs
  // nothing — it never reaches the Riot API again.
  const fresh = candidateIds.filter((id) => !db.hasGame(id) && !db.isSkipped(id, rosterCount));
  const cached = candidateIds.length - fresh.length;

  const qualifying = [];
  const newlySkipped = [];

  for (const matchId of fresh) {
    let match;
    try {
      match = await api.getMatch(matchId);
    } catch (err) {
      // A failed fetch is transient. Caching a skip here would permanently hide
      // a real game because of one bad response.
      console.error(`Failed to fetch match ${matchId}:`, err?.response?.status || err.message);
      continue;
    }
    const puuids = match.info.participants.map((p) => p.puuid);
    const overlap = trackedPuuids.filter((puuid) => puuids.includes(puuid));
    if (overlap.length >= 2) {
      qualifying.push({
        matchId,
        match,
        timestamp: match.info.gameEndTimestamp || match.info.gameStartTimestamp || 0
      });
    } else {
      newlySkipped.push({ matchId, reason: `only ${overlap.length} registered player(s) played` });
    }
  }

  db.markManySkipped(newlySkipped, rosterCount);

  qualifying.sort((a, b) => a.timestamp - b.timestamp); // oldest first — drain in order
  const toScore = qualifying.slice(0, maxToScore);

  const scored = [];
  for (const { matchId, match } of toScore) {
    const timeline = await api.getTimeline(matchId);

    let scores;
    try {
      scores = scoreMatch(match, { timeline, trackedPuuids });
    } catch (err) {
      // Remakes and other unscorable games are permanently unscorable — cache the
      // rejection rather than re-fetching them on every future scan.
      db.markSkipped(matchId, err.message, rosterCount);
      continue;
    }

    const scoresByDiscordId = {};
    for (const [puuid, s] of Object.entries(scores)) {
      const player = playerByPuuid[puuid];
      if (player) scoresByDiscordId[player.discordId] = s;
    }

    db.saveGame(matchId, {
      matchId,
      playedAt: match.info.gameEndTimestamp || match.info.gameStartTimestamp || Date.now(),
      queueId: match.info.queueId,
      durationSeconds: match.info.gameDuration,
      dataQuality: timeline ? 'full' : 'partial',
      scores: scoresByDiscordId
    });

    scored.push({ matchId, match, hasTimeline: Boolean(timeline), scores, scoresByDiscordId, nameByDiscordId });
  }

  return {
    scored,
    remaining: qualifying.length - toScore.length,
    checked: fresh.length,
    cached,
    skippedNow: newlySkipped.length,
    players
  };
}
