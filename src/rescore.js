// Re-scores stored games from the archived payloads (spec §10.1 `/recompute`).
//
// The model changes. It has changed a great deal — baselines went from hand-set
// guesses to measured medians, curves were rescaled to the spread they grade,
// and a whole anti-gaming term arrived. Every one of those changes left the
// games already in the database saying what the *old* model said, so a rolling
// average silently mixed scores that do not mean the same thing (finding F9).
//
// The old fix was `/resetgames` plus a re-fetch, which has two problems. It
// spends the Riot budget re-downloading payloads the bot already had, and since
// the seven-day fetch window it cannot reach anything older than a week — so a
// scoring change could only ever be applied to the last few games.
//
// This reads the archive instead. No API calls, no deletion, and every game ends
// up scored by one model rather than by whichever one happened to be deployed
// the day it was played.

import { db } from './storage.js';
import { scoreMatch } from './scoring/index.js';
import { enemySummary } from './embeds.js';
import { calibrationVersion } from './scoring/calibration.js';
import * as rawArchive from './rawArchive.js';
import { patchOf } from './drift.js';

/**
 * Re-scores what the archive can reach.
 *
 * @param {object} opts
 * @param {number|null} opts.last   only the N most recent games, newest first
 * @param {boolean} opts.dryRun     report what would change without writing
 * @param {(done: number, total: number) => void} opts.onProgress
 * @returns {Promise<object>} counts, the biggest movers, and what could not be done
 */
export async function rescoreStored({ last = null, dryRun = false, onProgress = null } = {}) {
  const players = db.allPlayers();
  const trackedPuuids = players.map((p) => p.puuid);
  const byPuuid = Object.fromEntries(players.map((p) => [p.puuid, p]));

  // Newest first, so `last: 20` means the twenty most recent.
  const stored = [...db.allGames()].sort((a, b) => b.playedAt - a.playedAt);
  const targets = last ? stored.slice(0, last) : stored;

  const result = {
    considered: targets.length,
    rescored: 0,
    unchanged: 0,
    missingPayload: 0,
    failed: [],
    movers: [],
    calibrationVersion: calibrationVersion(),
    dryRun
  };

  let done = 0;
  for (const game of targets) {
    done += 1;
    if (onProgress && done % 25 === 0) onProgress(done, targets.length);

    const archived = rawArchive.load(game.matchId);
    if (!archived?.match) {
      // Played before archiving existed, or the file is gone. Left exactly as it
      // is rather than dropped — a score from an older model is still a score,
      // and deleting someone's history to tidy up a version number is a worse
      // outcome than carrying it.
      result.missingPayload += 1;
      continue;
    }

    let scores;
    try {
      scores = scoreMatch(archived.match, { timeline: archived.timeline, trackedPuuids });
    } catch (err) {
      // A payload the current model refuses is worth knowing about: it means a
      // change made a previously scorable game unscorable.
      result.failed.push({ matchId: game.matchId, reason: err.message });
      continue;
    }

    const scoresByDiscordId = {};
    let squadTeamId = null;
    for (const [puuid, s] of Object.entries(scores)) {
      const player = byPuuid[puuid];
      if (player) {
        scoresByDiscordId[player.discordId] = s;
        squadTeamId = s.teamId;
      }
    }
    if (Object.keys(scoresByDiscordId).length === 0) {
      // Everyone in it has since been unregistered. Nothing to store against.
      result.missingPayload += 1;
      continue;
    }

    // What actually moved, for the report. The largest single swing is the
    // number worth showing: "nothing changed by more than 0.4" and "one game
    // moved 22 points" are different outcomes and should not read the same.
    let biggest = 0;
    let biggestWho = null;
    for (const [discordId, s] of Object.entries(scoresByDiscordId)) {
      const before = game.scores?.[discordId]?.composite;
      if (!Number.isFinite(before)) continue;
      const delta = s.composite - before;
      if (Math.abs(delta) > Math.abs(biggest)) {
        biggest = delta;
        biggestWho = discordId;
      }
    }

    if (Math.abs(biggest) < 0.05) {
      result.unchanged += 1;
    } else {
      result.rescored += 1;
      result.movers.push({
        matchId: game.matchId,
        playedAt: game.playedAt,
        discordId: biggestWho,
        delta: Math.round(biggest * 10) / 10
      });
    }

    if (!dryRun) {
      db.saveGame(game.matchId, {
        ...game,
        scores: scoresByDiscordId,
        enemy: enemySummary(scores, squadTeamId),
        dataQuality: archived.timeline ? 'full' : 'partial',
        // Backfilled from the payload, since games stored before this was
        // recorded have no patch and so cannot be checked against a calibration.
        patch: game.patch ?? patchOf(archived.match.info?.gameVersion)
      });
    }
  }

  result.movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  result.movers = result.movers.slice(0, 5);
  return result;
}

/** How much of the stored history the archive can currently reach. */
export function coverage() {
  const stored = db.allGames();
  const covered = stored.filter((g) => rawArchive.has(g.matchId)).length;
  return {
    stored: stored.length,
    covered,
    missing: stored.length - covered,
    pct: stored.length ? Math.round((covered / stored.length) * 100) : 0
  };
}
