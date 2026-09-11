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
import { isSupportedQueue, unsupportedReason, queueRulesKey } from './queues.js';
import { enemySummary } from './embeds.js';
import { config } from './config.js';

/**
 * Match history for one player, repairing a stale PUUID if that's what's wrong.
 *
 * PUUIDs issued under a Riot **development** key are scoped to that key. Dev keys
 * expire every 24 hours, so the moment you regenerate one, every stored PUUID
 * stops working — match-v5 answers `400 Exception decrypting <puuid>`. Account-v1
 * still resolves the Riot ID perfectly, so /register keeps working and nothing
 * looks broken; the bot just silently stops finding games.
 *
 * The Riot ID is the durable identifier, so on that failure we re-resolve the
 * PUUID from it, save the new one and retry.
 */
export async function repairPuuid(api, player) {
  const account = await api.getAccountByRiotId(player.riotGameName, player.riotTagLine);
  if (!account?.puuid || account.puuid === player.puuid) return null;

  console.log(`Refreshed stale PUUID for ${player.riotGameName}#${player.riotTagLine}`);
  db.upsertPlayer({ discordId: player.discordId, puuid: account.puuid });
  player.puuid = account.puuid; // keep the caller's copy in step
  return account.puuid;
}

/**
 * Epoch ms before which a game is too old to fetch, or null when the window is
 * switched off. Resolved once per scan so every player in one pass is measured
 * against the same instant.
 */
export function ageCutoff(now = Date.now(), days = config.maxGameAgeDays) {
  return days > 0 ? now - days * 24 * 60 * 60 * 1000 : null;
}

async function idsForPlayer(api, player, lookback, cutoff) {
  // Seconds, because that is what Riot's endpoint takes.
  const startTime = cutoff === null ? null : Math.floor(cutoff / 1000);
  try {
    return await api.getRecentMatchIds(player.puuid, lookback, null, { startTime });
  } catch (err) {
    const status = err?.response?.status;
    // 400 is the decryption failure; 404 covers a PUUID that no longer resolves.
    if (status !== 400 && status !== 404) throw err;

    const fresh = await repairPuuid(api, player);
    if (!fresh) throw err;
    return await api.getRecentMatchIds(fresh, lookback, null, { startTime });
  }
}

/**
 * Recent match ids across EVERY registered player, not just one "anchor" —
 * otherwise a game is missed entirely whenever that one anchor player is the
 * one sitting out the rotation for that match.
 *
 * Errors are returned rather than only logged: a scan that fetched nothing
 * because the API is down must not report the same "no new games" as a scan that
 * genuinely found nothing.
 */
async function collectCandidateIds(api, players, lookback, cutoff) {
  const idSet = new Set();
  const errors = [];
  for (const player of players) {
    try {
      const ids = await idsForPlayer(api, player, lookback, cutoff);
      ids.forEach((id) => idSet.add(id));
    } catch (err) {
      const status = err?.response?.status;
      const detail = status ? `HTTP ${status}` : err.message;
      console.error(`Failed to fetch match history for ${player.riotGameName}#${player.riotTagLine}: ${detail}`);
      errors.push({ player: `${player.riotGameName}#${player.riotTagLine}`, status: status ?? null, detail });
    }
  }
  return { ids: [...idSet], errors };
}

// Only one scan at a time, process-wide.
//
// A scan reads which games are already stored, then spends a dozen Riot calls
// fetching and scoring them, and only saves at the very end. Two scans overlapping
// therefore both decide a game is unscored, both score it, and both post it —
// one database row, two identical scorecards a minute apart. The watcher had a
// `running` flag but it only stopped watcher-vs-watcher; nothing stopped the
// watcher overlapping a manual /fetchgame, which is the pairing that actually
// happens, because people run /fetchgame when they notice the watcher is due.
//
// Serialising rather than rejecting: the second caller waits, then runs its own
// scan, which correctly sees what the first one saved. /fetchgame has already
// deferred its reply, so waiting costs it nothing.
let scanChain = Promise.resolve();

export function scanForNewGames(opts = {}) {
  const run = scanChain.then(
    () => runScan(opts),
    () => runScan(opts) // a failed scan must not wedge every scan after it
  );
  scanChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
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
async function runScan({ lookback = 5, maxToScore = 5, order = 'newest', api = riot } = {}) {
  const players = db.allPlayers();
  if (players.length < 2) {
    return { scored: [], remaining: 0, checked: 0, cached: 0, players, tooFewPlayers: true };
  }

  const rosterCount = players.length;
  // Rejections only stand while the rules that produced them still hold, and the
  // age window is one of those rules — widening it has to re-check games turned
  // away for being too old.
  //
  // The *setting* goes in the key, never the computed cutoff. The cutoff moves
  // every day, so keying on it would change the key on every scan and throw away
  // the entire skip cache each time, which is the one thing that keeps a scan
  // from re-fetching every solo queue game the squad has ever played.
  const rulesKey = `${queueRulesKey()}:age${config.maxGameAgeDays}`;
  const nameByDiscordId = Object.fromEntries(players.map((p) => [p.discordId, p.riotGameName]));

  // One instant for the whole scan, so every player is measured against the same
  // cutoff even if the pass takes a minute to work through six match histories.
  const cutoff = ageCutoff();
  const { ids: candidateIds, errors: apiErrors } = await collectCandidateIds(api, players, lookback, cutoff);
  // Recomputed after collectCandidateIds, which may have repaired stale PUUIDs.
  const trackedPuuidsNow = players.map((p) => p.puuid);

  // Anything already scored, or already rejected under this same roster, costs
  // nothing — it never reaches the Riot API again.
  const fresh = candidateIds.filter((id) => !db.hasGame(id) && !db.isSkipped(id, rosterCount, rulesKey));
  const cached = candidateIds.length - fresh.length;

  const qualifying = [];
  const newlySkipped = [];
  // Games already claimed by an earlier candidate in this same batch.
  const seenGameIds = new Set();

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

    // Older than the fetch window. Riot's `startTime` should already have kept
    // this id out of the candidate list, so reaching here means either the
    // window moved mid-scan or the endpoint returned something outside it. Left
    // in as a second line rather than trusted away, because the failure it
    // guards against — a months-old game posted as if it were last night's — is
    // the one the window exists to prevent.
    const playedAt = match.info.gameEndTimestamp || match.info.gameStartTimestamp || 0;
    if (cutoff !== null && playedAt > 0 && playedAt < cutoff) {
      const days = Math.round((Date.now() - playedAt) / (24 * 60 * 60 * 1000));
      newlySkipped.push({ matchId, reason: `played ${days} days ago, outside the ${config.maxGameAgeDays}-day window` });
      continue;
    }

    // Same game, different match id. Riot hands back more than one id for a
    // single Ranked 5s game, and the `hasGame` check above only knows about ids
    // — so without this the game is scored and posted again on every scan, and
    // shows up as a phantom backlog ("2 more games waiting" after playing one).
    // Cached as a skip so the second id is never fetched again either.
    //
    // Both halves are needed: the stored check catches the copy that turns up on
    // a later scan, `seenGameIds` the one sitting in the very same batch, which
    // nothing has saved yet.
    const gameId = match.info.gameId;
    if (gameId != null && (db.hasGameId(gameId) || seenGameIds.has(String(gameId)))) {
      newlySkipped.push({ matchId, reason: `already scored as another match id (game ${gameId})` });
      continue;
    }
    if (gameId != null) seenGameIds.add(String(gameId));

    const tracked = match.info.participants.filter((p) => trackedPuuidsNow.includes(p.puuid));
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

  db.markManySkipped(newlySkipped, rosterCount, rulesKey);

  qualifying.sort((a, b) => (order === 'newest' ? b.timestamp - a.timestamp : a.timestamp - b.timestamp));
  const toScore = qualifying.slice(0, maxToScore);

  const playerByPuuid = Object.fromEntries(players.map((p) => [p.puuid, p]));
  const scored = [];
  let deferred = 0;
  for (const { matchId, match } of toScore) {
    const { timeline, transientFailure } = await api.getTimeline(matchId);

    // A game is stored with whatever data was available when it was scored, and
    // never re-scored. Saving one now, with a rate limit or an expired key having
    // eaten the timeline, would bake a permanently degraded score into history.
    // Leaving it unscored costs nothing: the next scan picks it up again.
    if (transientFailure) {
      console.error(`Deferring ${matchId} — timeline fetch failed, will retry on the next scan.`);
      deferred += 1;
      continue;
    }

    let scores;
    try {
      scores = scoreMatch(match, { timeline, trackedPuuids: trackedPuuidsNow });
    } catch (err) {
      // Remakes and other unscorable games are permanently unscorable — cache the
      // rejection rather than re-fetching them on every future scan.
      db.markSkipped(matchId, err.message, rosterCount, rulesKey);
      continue;
    }

    const scoresByDiscordId = {};
    let squadTeamId = null;
    for (const [puuid, s] of Object.entries(scores)) {
      const player = playerByPuuid[puuid];
      if (player) {
        scoresByDiscordId[player.discordId] = s;
        squadTeamId = s.teamId;
      }
    }

    // The enemy line is stored too, so /match can rebuild the full scorecard
    // later without another round trip to Riot for the other five players.
    const enemy = enemySummary(scores, squadTeamId);

    db.saveGame(matchId, {
      matchId,
      // The game's own identity, which a match id is not: see db.hasGameId.
      gameId: match.info.gameId ?? null,
      platformId: match.info.platformId ?? null,
      playedAt: match.info.gameEndTimestamp || match.info.gameStartTimestamp || Date.now(),
      queueId: match.info.queueId,
      durationSeconds: match.info.gameDuration,
      dataQuality: timeline ? 'full' : 'partial',
      scores: scoresByDiscordId,
      enemy
    });

    scored.push({
      matchId,
      match,
      durationSeconds: match.info.gameDuration,
      playedAt: match.info.gameEndTimestamp || match.info.gameStartTimestamp || Date.now(),
      hasTimeline: Boolean(timeline),
      enemy,
      scores,
      scoresByDiscordId,
      nameByDiscordId
    });
  }

  // Recorded so /status can say when the bot last actually looked, which is the
  // difference between "nothing to report" and "quietly stopped working".
  db.setMeta('lastScanAt', Date.now());

  // Counts per reason, so "no new matches" can say *why* rather than leaving you
  // to guess whether the bot is broken or you just played ARAM.
  const skippedReasons = {};
  for (const { reason } of newlySkipped) skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;

  return {
    scored,
    // Deferred games are still "remaining" — they were not scored and will be
    // retried, so a caller reporting a backlog must count them.
    remaining: qualifying.length - toScore.length + deferred,
    deferred,
    checked: fresh.length,
    cached,
    apiErrors,
    skippedNow: newlySkipped.length,
    skippedReasons,
    players
  };
}
