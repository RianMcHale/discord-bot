import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.warn(`[config] Warning: ${name} is not set in .env`);
  }
  return v;
}

export const config = {
  // Where db.json lives. RAILWAY_VOLUME_MOUNT_PATH is injected automatically once
  // a volume is attached, so on Railway you only have to attach the volume —
  // there's no path to keep in sync. DATA_DIR overrides it anywhere else.
  dataDir: process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
  discordToken: required('DISCORD_TOKEN'),
  discordClientId: required('DISCORD_CLIENT_ID'),
  discordGuildId: process.env.DISCORD_GUILD_ID || null,
  riotApiKey: required('RIOT_API_KEY'),
  riotRegion: process.env.RIOT_REGION || 'americas',
  riotPlatform: process.env.RIOT_PLATFORM || 'euw1',
  rollingWindow: parseInt(process.env.ROLLING_WINDOW || '10', 10),

  // Discord user ids allowed to run destructive commands (/resetgames).
  // Defaults to the bot owner so it works without extra Railway config; override
  // with ADMIN_USER_IDS (comma-separated) to change who without a code change.
  adminUserIds: (process.env.ADMIN_USER_IDS || '323144087828168724')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),

  // Comma-separated queue ids to score. Unset uses the standard 5v5 Summoner's
  // Rift set in queues.js — see there for why ARAM, Arena and the rotating modes
  // are excluded rather than scored badly.
  allowedQueues: process.env.ALLOWED_QUEUES
    ? process.env.ALLOWED_QUEUES.split(',')
        .map((q) => parseInt(q.trim(), 10))
        .filter(Number.isFinite)
    : null,

  // Channel the watcher posts finished games to. Unset = watcher disabled and
  // /fetchgame stays manual.
  watchChannelId: process.env.DISCORD_WATCH_CHANNEL_ID || null,
  // All in seconds. Defaults are tuned for a Riot development key (100 requests
  // per 2 minutes); a production key could poll considerably harder.
  watchLiveInterval: parseInt(process.env.WATCH_LIVE_INTERVAL || '120', 10),
  watchIdleInterval: parseInt(process.env.WATCH_IDLE_INTERVAL || '180', 10),
  watchSettleInterval: parseInt(process.env.WATCH_SETTLE_INTERVAL || '45', 10),
  watchSafetyInterval: parseInt(process.env.WATCH_SAFETY_INTERVAL || '1800', 10)
};

/**
 * Whether a Discord user may run destructive commands.
 *
 * Fails closed: an empty or missing admin list means nobody can, rather than
 * everybody. Discord can only gate commands by permission, not by user id, so
 * this has to be checked at run time.
 */
export function isAdmin(discordId) {
  return config.adminUserIds.includes(discordId);
}
