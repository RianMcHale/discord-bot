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
  async getRecentMatchIds(puuid, count = 5, queue = null) {
    const params = { start: 0, count };
    if (queue) params.queue = queue;
    const { data } = await withRetry(() =>
      regional.get(`/lol/match/v5/matches/by-puuid/${puuid}/ids`, { params })
    );
    return data; // array of match id strings
  },

  async getMatch(matchId) {
    const { data } = await withRetry(() => regional.get(`/lol/match/v5/matches/${matchId}`));
    return data;
  },

  // Per-minute frames plus every kill/objective/ward event. Heavier than the match
  // response, but it's the only source for lane state at 14, who was actually
  // present when someone died, and how much jungle pressure each lane took —
  // i.e. most of what the role rubrics grade on. Returns null instead of throwing
  // so a missing timeline degrades the score rather than failing the command.
  async getTimeline(matchId) {
    try {
      const { data } = await withRetry(() => regional.get(`/lol/match/v5/matches/${matchId}/timeline`));
      return data;
    } catch (err) {
      console.error(`Timeline unavailable for ${matchId}:`, err?.response?.status || err.message);
      return null;
    }
  }
};
