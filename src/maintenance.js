// One-off cleanups that run at startup.

import { db } from './storage.js';
import { allowedQueues, queueName } from './queues.js';

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
 */
export function purgeUnsupportedGames() {
  const allowed = allowedQueues();
  const doomed = db
    .allGames()
    .filter((g) => typeof g.queueId === 'number' && !allowed.includes(g.queueId));

  if (doomed.length === 0) return { removed: 0, byQueue: {} };

  const byQueue = {};
  for (const g of doomed) {
    const name = queueName(g.queueId);
    byQueue[name] = (byQueue[name] || 0) + 1;
  }

  const removed = db.removeGames(doomed.map((g) => g.matchId));
  return { removed, byQueue };
}
