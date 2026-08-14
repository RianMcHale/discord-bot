// Posts finished games automatically, without anyone running /fetchgame.
//
// Riot has no webhooks and no push of any kind — the only way to learn a game
// finished is to ask. So the watcher asks a *cheap* question often instead of an
// expensive one rarely: the spectator endpoint says whether a tracked player is
// in a game right now, which turns "poll match history and hope" into a state
// machine that knows when a result is actually coming.
//
//   IDLE     nobody is in a game. Check the spectator endpoint every few
//            minutes, plus an occasional full scan as a safety net for games
//            that started and ended while the bot was down.
//   LIVE     someone is in a game. A result is coming, so keep checking — but
//            don't bother scanning match history, it won't be there yet.
//   SETTLING a game just ended. Riot takes up to a couple of minutes to publish
//            the match, so scan every ~45s until it appears or we give up.
//
// The practical effect is a scorecard within about a minute of the game ending,
// which is as close to instant as the API allows.

import { config } from './config.js';
import { db } from './storage.js';
import { riot } from './riotApi.js';
import { scanForNewGames } from './scanner.js';
import { buildMatchEmbed } from './embeds.js';

const SETTLE_ATTEMPTS = 8; // ~6 minutes at the default 45s interval

let timer = null;
let running = false;

const state = {
  phase: 'IDLE',
  settleAttempts: 0,
  lastSafetyScan: 0
};

/** True as soon as any tracked player is found in a game — stops asking after the first hit. */
async function anyPlayerInGame(players) {
  for (const player of players) {
    try {
      if (await riot.getActiveGame(player.puuid)) return true;
    } catch (err) {
      const status = err?.response?.status;
      if (status === 403) throw err; // expired key — surface it, don't swallow
      // Anything else is transient for this one player; keep checking the rest.
    }
  }
  return false;
}

async function scanAndPost(client, { maxToScore = 3 } = {}) {
  // Oldest first here: the watcher posts each game as its own message, so a
  // backlog should appear in the order it was played.
  const result = await scanForNewGames({ lookback: 5, maxToScore, order: 'oldest' });
  if (result.tooFewPlayers || result.scored.length === 0) return 0;

  const channel = await client.channels.fetch(config.watchChannelId).catch(() => null);
  if (!channel?.isTextBased?.()) {
    console.error(`Watcher: channel ${config.watchChannelId} is not a text channel the bot can post to.`);
    return 0;
  }

  const embeds = result.scored.map((game, i) =>
    buildMatchEmbed({
      scores: game.scores,
      scoresByDiscordId: game.scoresByDiscordId,
      nameByDiscordId: game.nameByDiscordId,
      matchInfo: game.match.info,
      hasTimeline: game.hasTimeline,
      alsoNew: i === result.scored.length - 1 ? result.remaining : 0
    }).embed
  );

  // One message per game, so each scorecard is its own thing to react to.
  for (const embed of embeds) {
    await channel.send({ embeds: [embed] }).catch((err) => console.error('Watcher: failed to post:', err.message));
  }
  return result.scored.length;
}

async function tick(client) {
  if (running) return; // a slow scan must not overlap the next tick
  running = true;
  try {
    const players = db.allPlayers();
    if (players.length < 2) return;

    const live = await anyPlayerInGame(players);

    if (live) {
      state.phase = 'LIVE';
      state.settleAttempts = 0;
      return;
    }

    // Just came out of a live game — a match should appear shortly.
    if (state.phase === 'LIVE') {
      state.phase = 'SETTLING';
      state.settleAttempts = 0;
    }

    if (state.phase === 'SETTLING') {
      const posted = await scanAndPost(client);
      state.settleAttempts += 1;
      if (posted > 0 || state.settleAttempts >= SETTLE_ATTEMPTS) {
        state.phase = 'IDLE';
        state.lastSafetyScan = Date.now();
      }
      return;
    }

    // IDLE: an occasional full scan catches anything the state machine missed —
    // a game played while the bot was restarting, most likely.
    if (Date.now() - state.lastSafetyScan >= config.watchSafetyInterval * 1000) {
      await scanAndPost(client);
      state.lastSafetyScan = Date.now();
    }
  } catch (err) {
    const status = err?.response?.status;
    if (status === 403) {
      console.error('Watcher: Riot API key rejected (403) — it may have expired. Watcher will keep retrying.');
    } else if (status === 429) {
      console.error('Watcher: rate limited by Riot, backing off until the next tick.');
    } else {
      console.error('Watcher tick failed:', err.message);
    }
  } finally {
    running = false;
    schedule(client);
  }
}

function delayFor() {
  if (state.phase === 'LIVE') return config.watchLiveInterval;
  if (state.phase === 'SETTLING') return config.watchSettleInterval;
  return config.watchIdleInterval;
}

function schedule(client) {
  clearTimeout(timer);
  timer = setTimeout(() => tick(client), delayFor() * 1000);
  timer.unref?.(); // never hold the process open on its own
}

export function startWatcher(client) {
  if (!config.watchChannelId) {
    console.log('Watcher disabled — set DISCORD_WATCH_CHANNEL_ID to auto-post finished games.');
    return;
  }
  console.log(
    `Watcher enabled on channel ${config.watchChannelId} ` +
      `(live ${config.watchLiveInterval}s · idle ${config.watchIdleInterval}s · settle ${config.watchSettleInterval}s)`
  );
  state.lastSafetyScan = 0; // scan once shortly after boot to catch up
  schedule(client);
}

export function stopWatcher() {
  clearTimeout(timer);
  timer = null;
}

// Exposed for tests.
export const _internals = { state, tick, delayFor };
