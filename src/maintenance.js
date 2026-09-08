// One-off cleanups that run at startup.

import { db } from './storage.js';
import { KNOWN_UNSUPPORTED_QUEUES, blockedQueues, queueName } from './queues.js';

/**
 * Drops stored games from queues that should never have been scored.
 *
 * Queue filtering was added after the bot had already been running, so any ARAM
 * or Arena game scored before that is sitting in the database dragging every
 * average around — a player's "career" number is meaningless if a third of it is
 * ARAM graded on a Summoner's Rift rubric.
 *
 * Only games with a recorded queueId are considered. Games saved before queueId
 * was stored are left alone rather than guessed at.
 *
 * It removes queues *known* to be wrong rather than everything not on the accept
 * list, and the difference is not cosmetic. This runs with only a stored
 * queueId, where the scanner had the whole match to look at — so an accept-list
 * check here overrules a decision made with far better information. That is
 * exactly what happened to Ranked 5s (queue 710): the scanner accepted it on the
 * structural check, this deleted it on every boot, the watcher re-found and
 * re-posted it, and the same three games came back after every deploy. A startup
 * task that knows less than the scanner must not overrule it.
 */
export function purgeUnsupportedGames() {
  const doomed = db
    .allGames()
    .filter(
      (g) =>
        typeof g.queueId === 'number' &&
        (KNOWN_UNSUPPORTED_QUEUES.has(g.queueId) || blockedQueues().includes(g.queueId))
    );

  if (doomed.length === 0) return { removed: 0, byQueue: {} };

  const byQueue = {};
  for (const g of doomed) {
    const name = queueName(g.queueId);
    byQueue[name] = (byQueue[name] || 0) + 1;
  }

  const removed = db.removeGames(doomed.map((g) => g.matchId));
  return { removed, byQueue };
}
