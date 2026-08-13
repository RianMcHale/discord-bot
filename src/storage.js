// Lightweight JSON-file storage. No native deps, easy to inspect/back up by hand.
// data/db.json shape:
// {
//   players: { [discordId]: { discordId, riotGameName, riotTagLine, puuid, role, addedAt } },
//   games: { [matchId]: { matchId, playedAt, queueId, scores: { [discordId]: {composite, breakdown, role} } } },
//   votes: { [matchId]: { [voterDiscordId]: { [targetDiscordId]: rating } } }
// }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

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
  }
};
