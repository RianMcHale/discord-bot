// Keeps the raw Riot payload for every scored game (spec Phase 1, finding F9).
//
// Until now the bot fetched a match, scored it, stored the scores and threw the
// payload away. Three things follow from that, and all three are problems:
//
//   * Re-scoring history means re-fetching it. That was merely expensive before
//     the seven-day fetch window; now it is impossible — anything older than a
//     week cannot be recovered from Riot at all, so a scoring change silently
//     applies only to last week's games.
//   * The golden fixtures §11.1 asks for cannot be built, because there are no
//     real match/timeline pairs to build them from.
//   * A score cannot be reproduced, which is F9. "Why did this game score 44"
//     has no answer once the inputs are gone.
//
// One gzipped file per match. Riot payloads are deeply repetitive — a timeline
// is the same forty fields per participant per minute — so they compress hard,
// and `stats()` reports what it is actually costing rather than leaving it to be
// guessed at.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Same resolution as the score store, so one volume holds both. */
function archiveDir() {
  return path.join(config.dataDir || path.join(__dirname, '..', 'data'), 'raw');
}

// A match id is `EUW1_7977729427` — letters, digits and one underscore. Checked
// rather than trusted, because the id becomes a filename.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const fileFor = (matchId) => path.join(archiveDir(), `${matchId}.json.gz`);

/** Whether archiving is on. Off means the bot behaves exactly as it used to. */
export const enabled = () => config.archiveRaw !== false;

export function has(matchId) {
  if (!SAFE_ID.test(matchId)) return false;
  return fs.existsSync(fileFor(matchId));
}

/**
 * Stores one match and its timeline. Returns the bytes written, or null when
 * archiving is off or the id is not one we are willing to turn into a path.
 *
 * Never throws. A failed archive must not stop a game being scored and posted —
 * the archive is a convenience for later, not part of the scoring path.
 */
export function save(matchId, { match, timeline = null }) {
  if (!enabled() || !SAFE_ID.test(matchId) || !match) return null;
  try {
    fs.mkdirSync(archiveDir(), { recursive: true });
    const body = zlib.gzipSync(
      JSON.stringify({ matchId, archivedAt: Date.now(), match, timeline }),
      // 9 rather than the default 6: this is written once and read rarely, so
      // the extra CPU is spent in the right place.
      { level: 9 }
    );
    // Written beside the target and renamed, so a crash mid-write cannot leave a
    // half-file that later reads as corrupt.
    const tmp = `${fileFor(matchId)}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, fileFor(matchId));
    return body.length;
  } catch (err) {
    console.error(`Could not archive ${matchId}: ${err.message}`);
    return null;
  }
}

/** The stored payload, or null if it isn't there or won't parse. */
export function load(matchId) {
  if (!has(matchId)) return null;
  try {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(fileFor(matchId))).toString('utf-8'));
  } catch (err) {
    console.error(`Archived ${matchId} is unreadable: ${err.message}`);
    return null;
  }
}

/** Every archived match id. */
export function list() {
  try {
    return fs
      .readdirSync(archiveDir())
      .filter((f) => f.endsWith('.json.gz'))
      .map((f) => f.slice(0, -'.json.gz'.length));
  } catch {
    return [];
  }
}

export function remove(matchId) {
  if (!has(matchId)) return false;
  try {
    fs.unlinkSync(fileFor(matchId));
    return true;
  } catch {
    return false;
  }
}

/** What the archive is costing, in real numbers rather than an estimate. */
export function stats() {
  const ids = list();
  let bytes = 0;
  for (const id of ids) {
    try {
      bytes += fs.statSync(fileFor(id)).size;
    } catch {
      /* raced with a delete; not worth failing a status line over */
    }
  }
  return {
    games: ids.length,
    bytes,
    mb: +(bytes / 1024 / 1024).toFixed(2),
    perGameKb: ids.length ? +(bytes / ids.length / 1024).toFixed(1) : 0,
    enabled: enabled(),
    dir: archiveDir()
  };
}
