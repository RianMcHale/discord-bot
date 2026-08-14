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
import { isSupportedQueue, unsupportedReason } from './queues.js';

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
 * @param {number} opts.maxToScore cap per run, to bound Riot API usage
 * @param {'newest'|'oldest'} opts.order  which end of the backlog to take from.
 *   'newest' is what you want on demand — the game you just played is the one you
 *   asked about. 'oldest' is for the watcher, which posts each game separately
 *   and should therefore read in the order they were played.
 * @returns {Promise<{scored: object[], remaining: number, checked: number, cached: number, players: object[]}>}
 */
export async function scanForNewGames({ lookback = 5, maxToScore = 5, order = 'newest', api = riot } = {}) {
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
    // Wrong mode entirely — ARAM, Arena, bots, URF. The rubrics assume Summoner's
    // Rift roles and a lane counterpart, neither of which exists there.
    if (!isSupportedQueue(match.info)) {
      newlySkipped.push({ matchId, reason: unsupportedReason(match.info) });
      continue;
    }

    const tracked = match.info.participants.filter((p) => trackedPuuids.includes(p.puuid));
    if (tracked.length < 2) {
      newlySkipped.push({ matchId, reason: `only ${tracked.length} registered player(s) played` });
      continue;
    }

    // "Played together" means the same side. Tracked players split across both
    // teams isn't a squad game — the scorecard would list teammates under
    // "Enemy team" and the bench call would compare across the two.
    const teams = new Set(tracked.map((p) => p.teamId));
    if (teams.size > 1) {
      newlySkipped.push({ matchId, reason: 'registered players were on opposing teams' });
      continue;
    }

    qualifying.push({
      matchId,
      match,
      timestamp: match.info.gameEndTimestamp || match.info.gameStartTimestamp || 0
    });
  }

  db.markManySkipped(newlySkipped, rosterCount);

  qualifying.sort((a, b) => (order === 'newest' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp));
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

  // Counts per reason, so "no new matches" can say *why* rather than leaving you
  // to guess whether the bot is broken or you just played ARAM.
  const skippedReasons = {};
  for (const { reason } of newlySkipped) skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;

  return {
    scored,
    remaining: qualifying.length - toScore.length,
    checked: fresh.length,
    cached,
    skippedNow: newlySkipped.length,
    skippedReasons,
    players
  };
}
