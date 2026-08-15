// Points the store at a throwaway directory. Must be called BEFORE anything
// imports storage.js, since DATA_DIR is read once at module load.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function useTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lolbench-test-'));
  process.env.DATA_DIR = dir;
  process.env.DISCORD_TOKEN ||= 'test-token';
  process.env.DISCORD_CLIENT_ID ||= 'test-client';

  // config.js loads dotenv, which would otherwise pull the developer's real .env
  // into the test run — a test that passes or fails depending on whose machine
  // it runs on is worse than no test. dotenv never overwrites an existing key,
  // so setting these to empty pins them off. Both read as "unset" in config.js.
  for (const key of ['DISCORD_WATCH_CHANNEL_ID', 'ALLOWED_QUEUES', 'DISCORD_GUILD_ID']) {
    if (process.env[key] === undefined) process.env[key] = '';
  }

  return dir;
}

/** A stored game record, shaped the way scanner.js writes them. */
export function gameRecord({ matchId, playedAt, scores, dataQuality = 'full' }) {
  return { matchId, playedAt, queueId: 420, durationSeconds: 1800, dataQuality, scores };
}

export function playerScore({ composite, role, champion = 'Champ', win = true, kda = '4/4/6' }) {
  return {
    composite,
    grade: composite >= 60 ? 'B' : composite >= 47 ? 'C' : composite >= 36 ? 'D' : 'F',
    role,
    champion,
    kda,
    win,
    components: [{ key: 'lane', label: 'Lane', weight: 25, score: composite, detail: null }],
    breakdown: { lane: composite },
    context: {},
    notes: []
  };
}
