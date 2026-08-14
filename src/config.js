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
  rollingWindow: parseInt(process.env.ROLLING_WINDOW || '10', 10)
};
