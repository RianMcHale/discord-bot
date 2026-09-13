// Lightweight JSON-file storage. No native deps, easy to inspect/back up by hand.
// data/db.json shape:
// {
//   players: { [discordId]: { discordId, riotGameName, riotTagLine, puuid, addedAt } },
//   games: { [matchId]: { matchId, playedAt, queueId, durationSeconds, dataQuality,
//     scores: { [discordId]: { composite, grade, role, champion, kda, win,
//                              components: [{key,label,weight,score,detail}],
//                              breakdown: {key: score}, context: {...}, notes: [] } } } },
//   skipped: { [matchId]: { reason, rosterCount } }
// }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// config.dataDir lets the store live somewhere other than the repo — a mounted
// volume on a host with an ephemeral filesystem, or a throwaway dir under test.
const DATA_DIR = config.dataDir || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

// Exported so startup can log it. On a host with an ephemeral filesystem this is
// the difference between history that survives a deploy and history that doesn't,
// and it's not something you want to find out about after a month of games.
export const dbPath = DB_PATH;

const EMPTY = { players: {}, games: {}, skipped: {}, meta: {}, benchLog: [] };

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY, null, 2));
}

// The last state that parsed cleanly, kept beside the live file. Recovering from
// this rather than from nothing is the difference between losing a scan and
// losing a season: `read()` returning empty does not merely lose the data in
// memory, it is persisted by the very next `write()`, so one bad read silently
// destroys the whole history and every stored game gets re-fetched and re-posted.
const BACKUP_PATH = `${DB_PATH}.bak`;

function parseFile(file) {
  // Spread over EMPTY so a db written by an older version (no `skipped` key, or
  // carrying the removed `votes` key) still reads cleanly.
  return { ...EMPTY, ...JSON.parse(fs.readFileSync(file, 'utf-8')) };
}

function read() {
  ensureDb();
  try {
    return parseFile(DB_PATH);
  } catch (err) {
    // An unreadable file used to throw out of every command and every watcher
    // tick, taking the whole bot down until someone edited JSON by hand. Move it
    // aside and carry on: a bot that runs is more useful than one that refuses
    // to start. But carrying on from *empty* is its own disaster, so the last
    // good copy is tried first.
    const corrupt = `${DB_PATH}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(DB_PATH, corrupt);
    } catch {
      /* the backup is best-effort; never let it stop recovery */
    }

    if (fs.existsSync(BACKUP_PATH)) {
      try {
        const restored = parseFile(BACKUP_PATH);
        const games = Object.keys(restored.games || {}).length;
        console.error(
          `db.json could not be read (${err.message}). Bad copy saved to ${corrupt}. ` +
            `Restored the last good state from ${BACKUP_PATH} — ${games} scored game(s).`
        );
        fs.writeFileSync(DB_PATH, JSON.stringify(restored, null, 2));
        return restored;
      } catch (backupErr) {
        console.error(`The backup at ${BACKUP_PATH} is unreadable too (${backupErr.message}).`);
      }
    }

    console.error(
      `db.json could not be read (${err.message}) and there is no usable backup. ` +
        `Bad copy saved to ${corrupt}, starting from empty. Every stored game will be re-fetched.`
    );
    fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY, null, 2));
    return { ...EMPTY };
  }
}

let writeCounter = 0;

function write(db) {
  // Write-then-rename, because rename is atomic within a filesystem. A plain
  // writeFileSync that is interrupted — a deploy, an OOM kill — leaves a
  // half-written file behind, which is how the corruption above happens.
  //
  // The temp name carries the pid and a counter. A fixed name is safe within one
  // process, since writes here are synchronous, but not across two: a deploy
  // overlaps the old container with the new one, both mounted on the same volume,
  // and a shared scratch file is then two writers racing on one path.
  const json = JSON.stringify(db, null, 2);
  const tmp = `${DB_PATH}.tmp-${process.pid}-${writeCounter++}`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, DB_PATH);

  // The recovery point is the state just committed, not the one it replaced, so
  // recovering loses nothing rather than rewinding by a write. Written after the
  // rename: if that failed, the previous good state is still what is on disk and
  // still what the backup holds.
  try {
    fs.writeFileSync(BACKUP_PATH, json);
  } catch {
    /* best-effort: never let backup failure block the write itself */
  }
}

export const db = {
  getPlayer(discordId) {
    return read().players[discordId] || null;
  },
  getPlayerByPuuid(puuid) {
    return Object.values(read().players).find((p) => p.puuid === puuid) || null;
  },
  allPlayers() {
    return Object.values(read().players);
  },
  upsertPlayer(player) {
    const state = read();
    state.players[player.discordId] = { ...(state.players[player.discordId] || {}), ...player };
    write(state);
    return state.players[player.discordId];
  },
  hasGame(matchId) {
    return Boolean(read().games[matchId]);
  },
  saveGame(matchId, gameRecord) {
    const state = read();
    state.games[matchId] = gameRecord;
    write(state);
  },
  allGames() {
    return Object.values(read().games).sort((a, b) => a.playedAt - b.playedAt);
  },

  /**
   * Has this *game* been scored, under any match id?
   *
   * `hasGame` asks about a match id, which is not the same question. Riot can
   * hand back more than one match id for a single game — Ranked 5s does — and
   * when it does, a match-id check never fires and the same game is scored and
   * posted again on every scan. `info.gameId` is the numeric identity of the
   * game itself and does not vary.
   */
  hasGameId(gameId) {
    if (gameId === undefined || gameId === null) return false;
    return Object.values(read().games).some((g) => g.gameId != null && String(g.gameId) === String(gameId));
  },

  /**
   * Stored games that are the same game more than once, newest kept last.
   *
   * Grouped on `gameId` where it was recorded. Rows written before it was
   * stored fall back to a content signature — when it was played, who played,
   * and on what — which is specific enough that a real collision would mean two
   * identical lineups finishing a game in the same second.
   */
  duplicateGroups() {
    const groups = new Map();
    for (const g of this.allGames()) {
      const key =
        g.gameId != null
          ? `id:${g.gameId}`
          : `sig:${g.playedAt}:${Object.entries(g.scores || {})
              .map(([id, s]) => `${id}=${s.champion ?? ''}`)
              .sort()
              .join(',')}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(g);
    }
    return [...groups.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([key, rows]) => {
        // Keep the one with the best data, then the lowest match id so the
        // choice is stable across runs.
        const ranked = [...rows].sort(
          (a, b) =>
            (b.dataQuality === 'full' ? 1 : 0) - (a.dataQuality === 'full' ? 1 : 0) ||
            String(a.matchId).localeCompare(String(b.matchId))
        );
        return { key, keep: ranked[0], remove: ranked.slice(1) };
      });
  },
  getGame(matchId) {
    return read().games[matchId] || null;
  },
  gamesForPlayer(discordId, limit) {
    const games = this.allGames()
      .filter((g) => g.scores[discordId])
      .reverse(); // most recent first
    return limit ? games.slice(0, limit) : games;
  },
  resetGames() {
    const state = read();
    state.games = {};
    state.skipped = {};
    write(state);
  },
  removeGames(matchIds) {
    if (matchIds.length === 0) return 0;
    const state = read();
    let removed = 0;
    for (const id of matchIds) {
      if (state.games[id]) {
        delete state.games[id];
        removed += 1;
      }
    }
    write(state);
    return removed;
  },

  // --- matches checked and rejected ------------------------------------------
  // A match with fewer than two tracked players can never be scored, but without
  // remembering that, every solo queue game any player has ever played gets
  // re-fetched from Riot on every single scan. rosterCount guards the cache: if
  // someone new registers, an old rejection may no longer hold, so it's rechecked.
  skippedCount() {
    return Object.keys(read().skipped).length;
  },
  // `rulesKey` guards it the same way: a rejection only stands while the rules
  // that produced it still hold. Widening which queues are supported used to
  // leave every game already turned away permanently skipped, so the fix never
  // reached the games it was written for. Entries written before this existed
  // have no key and are re-checked once.
  isSkipped(matchId, rosterCount, rulesKey = null) {
    const entry = read().skipped[matchId];
    if (!entry || entry.rosterCount !== rosterCount) return false;
    return rulesKey === null || entry.rulesKey === rulesKey;
  },
  // Why a match was turned away, or null if it never was. The reason has always
  // been written; nothing could read it back, so a scan that quietly found
  // nothing could not be explained after the fact.
  skippedReason(matchId) {
    return read().skipped[matchId]?.reason ?? null;
  },
  markSkipped(matchId, reason, rosterCount, rulesKey = null) {
    const state = read();
    state.skipped[matchId] = { reason, rosterCount, rulesKey };
    write(state);
  },
  markManySkipped(entries, rosterCount, rulesKey = null) {
    if (entries.length === 0) return;
    const state = read();
    for (const { matchId, reason } of entries) state.skipped[matchId] = { reason, rosterCount, rulesKey };
    write(state);
  },

  /**
   * Records what /worst said, frozen at the moment it said it (spec §12.4).
   *
   * Append-only, and deliberately a copy rather than a reference. A bench call is
   * built from scores that can change underneath it — /rescore rewrites them
   * whenever the model improves — so "why was I benched six weeks ago" cannot be
   * answered by recomputing today. It can only be answered by what was written
   * down then.
   *
   * Running /worst again with nothing changed does not add a second entry; it
   * bumps the count on the first. Otherwise the log records how often people
   * looked, not what the bot said.
   */
  logBenchCall(entry) {
    const state = read();
    const log = Array.isArray(state.benchLog) ? state.benchLog : [];
    const last = log[log.length - 1];

    if (last && last.fingerprint === entry.fingerprint) {
      last.timesShown = (last.timesShown ?? 1) + 1;
      last.lastShownAt = entry.at;
    } else {
      log.push({ ...entry, timesShown: 1, lastShownAt: entry.at });
    }

    // Bounded so a year of calls cannot grow the one file every command reads.
    // Five hundred distinct verdicts is years of a squad's bench decisions.
    state.benchLog = log.slice(-500);
    write(state);
    return state.benchLog[state.benchLog.length - 1];
  },

  /** Recorded bench calls, newest first; optionally only those naming one player. */
  benchLog({ discordId = null, limit = 10 } = {}) {
    const log = Array.isArray(read().benchLog) ? read().benchLog : [];
    return log
      .filter((e) => !discordId || e.named?.some((n) => n.discordId === discordId))
      .slice()
      .reverse()
      .slice(0, limit);
  },

  // Small key/value bag for bot bookkeeping that isn't player or game data.
  getMeta(key) {
    return read().meta[key] ?? null;
  },
  setMeta(key, value) {
    const state = read();
    state.meta[key] = value;
    write(state);
  }
};
