// Lightweight JSON-file storage. No native deps, easy to inspect/back up by hand.
// data/db.json shape:
// {
//   players: { [discordId]: { discordId, riotGameName, riotTagLine, puuid, role, addedAt } },
//   games: { [matchId]: { matchId, playedAt, queueId, durationSeconds, dataQuality,
//     scores: { [discordId]: { composite, grade, role, champion, kda, win,
//                              components: [{key,label,weight,score,detail}],
//                              breakdown: {key: score}, context: {...}, notes: [] } } } },
//   votes: { [matchId]: { [voterDiscordId]: { [targetDiscordId]: rating } } }
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

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ players: {}, games: {}, votes: {} }, null, 2));
  }
}

function read() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

function write(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

export const db = {
  getPlayer(discordId) {
    return read().players[discordId] || null;
  },
  getPlayerByPuuid(puuid) {
    const players = read().players;
    return Object.values(players).find((p) => p.puuid === puuid) || null;
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
  removePlayer(discordId) {
    const state = read();
    delete state.players[discordId];
    write(state);
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
    resetGames() {
    const state = read();
    state.games = {};
    state.votes = {};
    write(state);
  },
  gamesForPlayer(discordId, limit) {
    const games = this.allGames()
      .filter((g) => g.scores[discordId])
      .reverse(); // most recent first
    return limit ? games.slice(0, limit) : games;
  },
  addVote(matchId, voterId, targetId, rating) {
    const state = read();
    if (!state.votes[matchId]) state.votes[matchId] = {};
    if (!state.votes[matchId][voterId]) state.votes[matchId][voterId] = {};
    state.votes[matchId][voterId][targetId] = rating;
    write(state);
  },
  votesForGame(matchId) {
    return read().votes[matchId] || {};
  },
  // Every match's votes in one read. votesForGame() re-reads and re-parses the
  // whole file per call, which is fine for a single game but not for stats that
  // walk every game ever played.
  allVotes() {
    return read().votes || {};
  }
};
