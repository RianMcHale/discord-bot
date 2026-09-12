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

  // How far back a game may have been played and still be fetchable.
  //
  // Riot's match-ids endpoint takes a `startTime`, so this is enforced before a
  // call is spent rather than after: anything older never enters the candidate
  // list at all. Set to 0 to turn the window off and go back to whatever the
  // lookback count reaches.
  //
  // Worth knowing before changing it: `/resetgames` followed by a re-scan can
  // only bring back games inside this window. Widen it temporarily if you are
  // re-scoring history after a scoring change.
  maxGameAgeDays: parseInt(process.env.MAX_GAME_AGE_DAYS || '7', 10),
  // `LEADERBOARD_MIN_GAMES` was here. The leaderboard now uses the same rating
  // as /worst, so it uses the same eligibility rule too —
  // `BENCH_MIN_EFFECTIVE_GAMES`, which counts recency-weighted games rather than
  // raw ones. Two thresholds for one question is how the two commands came to
  // disagree about who was even on the board.
  //
  // If it is set in the environment it now does nothing; the replacement is
  // BENCH_MIN_EFFECTIVE_GAMES (default 4).
  // Games needed to appear on the all-time standings. Lower than the recent-form
  // minimum because it's a career record, not a bench call — but a leaderboard
  // still shouldn't rank someone on a single game.
  alltimeMinGames: parseInt(process.env.ALLTIME_MIN_GAMES || '3', 10),

  // Keep the raw Riot payload for every scored game, gzipped, one file each.
  //
  // On by default because without it a scoring change can only be applied to
  // games still inside the fetch window — everything older is unreachable from
  // Riot and therefore frozen at whatever the model said when it was first
  // scored. `/rescore` reads these and needs no API calls at all.
  //
  // Set ARCHIVE_RAW=0 if the volume is tight. `/status` reports what it is
  // actually using.
  archiveRaw: process.env.ARCHIVE_RAW !== '0',

  // The bench decision's two statistical thresholds (spec §8.3).
  //
  // `benchMinEffectiveGames` counts *recency-weighted* games, so six games where
  // five are from last month is not six. Below it, a player cannot be benched by
  // data at all.
  //
  // `benchOverlapTolerance` is how far the bottom two players' 95% ranges may
  // overlap before /worst refuses to name either and reports a tie instead.
  // Raising it makes the bot more willing to name someone; 1.0 disables the
  // check entirely and goes back to benching on whoever happens to be lowest.
  benchMinEffectiveGames: parseFloat(process.env.BENCH_MIN_EFFECTIVE_GAMES || '4'),
  benchOverlapTolerance: parseFloat(process.env.BENCH_OVERLAP_TOLERANCE || '0.5'),

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
  //
  // This is an *accept* list, not a restriction: a queue that isn't on it is
  // still scored when it is structurally a normal Rift game, which is what lets
  // queues Riot adds later work without a code change. Use BLOCKED_QUEUES to
  // actually exclude something.
  allowedQueues: process.env.ALLOWED_QUEUES
    ? process.env.ALLOWED_QUEUES.split(',')
        .map((q) => parseInt(q.trim(), 10))
        .filter(Number.isFinite)
    : null,

  // Comma-separated queue ids to never score, whatever else says otherwise.
  // The only way to exclude a queue that would otherwise look like a normal
  // Rift game — Swiftplay, say, whose pacing makes the baselines misleading.
  blockedQueues: process.env.BLOCKED_QUEUES
    ? process.env.BLOCKED_QUEUES.split(',')
        .map((q) => parseInt(q.trim(), 10))
        .filter(Number.isFinite)
    : [],

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
