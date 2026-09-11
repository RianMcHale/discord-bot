import axios from 'axios';
import { config } from './config.js';

function client(baseURL) {
  return axios.create({
    baseURL,
    headers: { 'X-Riot-Token': config.riotApiKey },
    timeout: 10000
  });
}

const regional = client(`https://${config.riotRegion}.api.riotgames.com`);
const platform = client(`https://${config.riotPlatform}.api.riotgames.com`);

async function withRetry(fn, retries = 2) {
  try {
    return await fn();
  } catch (err) {
    const status = err?.response?.status;
    if (status === 429 && retries > 0) {
      const retryAfter = Number(err.response.headers['retry-after'] || 1);
      await new Promise((r) => setTimeout(r, (retryAfter + 0.5) * 1000));
      return withRetry(fn, retries - 1);
    }
    throw err;
  }
}

export const riot = {
  // Riot ID = gameName#tagLine (the new universal identifier, replaces summoner name lookups)
  async getAccountByRiotId(gameName, tagLine) {
    const { data } = await withRetry(() =>
      regional.get(`/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`)
    );
    return data; // { puuid, gameName, tagLine }
  },

  async getSummonerByPuuid(puuid) {
    const { data } = await withRetry(() => platform.get(`/lol/summoner/v4/summoners/by-puuid/${puuid}`));
    return data;
  },

  // Most recent match ids for a player. queue=420 is ranked solo/duo; pass null for all queues.
  //
  // `startTime` is epoch SECONDS, not milliseconds, and Riot applies it to when
  // a match started. Filtering here rather than after fetching is the point:
  // a match id that never comes back never costs a match call to reject.
  async getRecentMatchIds(puuid, count = 5, queue = null, { startTime = null } = {}) {
    const params = { start: 0, count };
    if (queue) params.queue = queue;
    if (Number.isFinite(startTime) && startTime > 0) params.startTime = Math.floor(startTime);
    const { data } = await withRetry(() =>
      regional.get(`/lol/match/v5/matches/by-puuid/${puuid}/ids`, { params })
    );
    return data; // array of match id strings
  },

  async getMatch(matchId) {
    const { data } = await withRetry(() => regional.get(`/lol/match/v5/matches/${matchId}`));
    return data;
  },

  // Is this player in a game right now? Returns null when they aren't (Riot
  // answers 404, which is the normal case, not an error). This is what lets the
  // watcher know a result is coming instead of blindly polling match history.
  async getActiveGame(puuid) {
    try {
      const { data } = await withRetry(() => platform.get(`/lol/spectator/v5/active-games/by-summoner/${puuid}`));
      return data;
    } catch (err) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  },

  // Per-minute frames plus every kill/objective/ward event. Heavier than the match
  // response, but it's the only source for lane state at 14, who was actually
  // present when someone died, and how much jungle pressure each lane took —
  // i.e. most of what the role rubrics grade on.
  //
  // Distinguishes "this match has no timeline" from "the request failed". A game
  // scored without a timeline is stored that way permanently, so a rate limit or
  // an expired key must not be allowed to bake degraded scores into history —
  // the caller defers those and retries on the next scan.
  async getTimeline(matchId) {
    try {
      const { data } = await withRetry(() => regional.get(`/lol/match/v5/matches/${matchId}/timeline`));
      return { timeline: data, transientFailure: false };
    } catch (err) {
      const status = err?.response?.status ?? null;
      const transientFailure = status !== 404;
      console.error(
        `Timeline ${transientFailure ? 'request failed' : 'not available'} for ${matchId}:`,
        status ?? err.message
      );
      return { timeline: null, transientFailure, status };
    }
  }
};
