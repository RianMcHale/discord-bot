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

const EMPTY = { players: {}, games: {}, skipped: {}, meta: {} };

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY, null, 2));
}

function read() {
  ensureDb();
  try {
    // Spread over EMPTY so a db written by an older version (no `skipped` key, or
    // carrying the removed `votes` key) still reads cleanly.
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    return { ...EMPTY, ...parsed };
  } catch (err) {
    // An unreadable file used to throw out of every command and every watcher
    // tick, taking the whole bot down until someone edited JSON by hand. Move it
    // aside and carry on: the backup keeps the data recoverable, and a bot that
    // runs is more useful than one that refuses to start.
    const backup = `${DB_PATH}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(DB_PATH, backup);
    } catch {
      /* the backup is best-effort; never let it stop recovery */
    }
    console.error(`db.json could not be read (${err.message}). Backed up to ${backup}, starting from empty.`);
    fs.writeFileSync(DB_PATH, JSON.stringify(EMPTY, null, 2));
    return { ...EMPTY };
  }
}

function write(db) {
  // Write-then-rename, because rename is atomic within a filesystem. A plain
  // writeFileSync that is interrupted — a deploy, an OOM kill — leaves a
  // half-written file behind, which is how the corruption above happens.
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
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
  isSkipped(matchId, rosterCount) {
    const entry = read().skipped[matchId];
    return Boolean(entry) && entry.rosterCount === rosterCount;
  },
  markSkipped(matchId, reason, rosterCount) {
    const state = read();
    state.skipped[matchId] = { reason, rosterCount };
    write(state);
  },
  markManySkipped(entries, rosterCount) {
    if (entries.length === 0) return;
    const state = read();
    for (const { matchId, reason } of entries) state.skipped[matchId] = { reason, rosterCount };
    write(state);
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
