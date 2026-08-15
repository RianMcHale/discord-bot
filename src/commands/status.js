import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { db, dbPath } from '../storage.js';
import { riot } from '../riotApi.js';
import { config } from '../config.js';
import { watcherStatus } from '../watcher.js';
import { allowedQueues } from '../queues.js';

/**
 * Health check.
 *
 * Exists because the bot's failure mode is silence: an expired key or a stale
 * PUUID produces "no new matches found", which is indistinguishable from having
 * played nothing. Every check here is one that has actually gone wrong.
 */
export const data = new SlashCommandBuilder()
  .setName('status')
  .setDescription("Check the bot's health: Riot API, player lookups, watcher, stored data.");

const OK = '✅';
const WARN = '⚠️';
const BAD = '❌';

/**
 * Probes each player's match history. This is the exact call the scanner makes,
 * so it fails the same way the scanner would.
 *
 * 403 means the key itself is rejected. 400 means the stored PUUID can't be
 * decrypted by the current key — the scanner repairs that automatically on its
 * next run, so it's a warning rather than a failure.
 */
async function probePlayers(players, api) {
  const results = [];
  for (const player of players) {
    try {
      await api.getRecentMatchIds(player.puuid, 1);
      results.push({ player, ok: true });
    } catch (err) {
      results.push({ player, ok: false, status: err?.response?.status ?? null });
    }
  }
  return results;
}

export async function execute(interaction, { api = riot } = {}) {
  await interaction.deferReply();

  const players = db.allPlayers();
  const games = db.allGames();
  const watcher = watcherStatus();

  const probes = players.length > 0 ? await probePlayers(players, api) : [];
  const failed = probes.filter((p) => !p.ok);
  const keyRejected = failed.some((p) => p.status === 403);
  const staleP = failed.filter((p) => p.status === 400 || p.status === 404);

  const lines = [];

  // --- Riot API ------------------------------------------------------------
  if (players.length === 0) {
    lines.push(`${WARN} **Riot API** — nothing to check, no players registered`);
  } else if (keyRejected) {
    lines.push(`${BAD} **Riot API** — key rejected (403). It is missing, invalid or expired.`);
  } else if (failed.length === players.length) {
    lines.push(`${BAD} **Riot API** — every lookup failed (${failed[0].status ?? 'network error'})`);
  } else {
    lines.push(`${OK} **Riot API** — key accepted`);
  }

  // --- player lookups ------------------------------------------------------
  if (players.length > 0) {
    const ok = probes.length - failed.length;
    if (failed.length === 0) {
      lines.push(`${OK} **Player lookups** — ${ok}/${players.length} resolving`);
    } else if (staleP.length > 0 && !keyRejected) {
      lines.push(
        `${WARN} **Player lookups** — ${ok}/${players.length} resolving · ` +
          `${staleP.length} stale PUUID${staleP.length === 1 ? '' : 's'}, repaired automatically on the next scan`
      );
      lines.push(`-# stale: ${staleP.map((p) => p.player.riotGameName).join(', ')}`);
    } else {
      lines.push(`${BAD} **Player lookups** — ${ok}/${players.length} resolving`);
    }
  }

  // --- watcher -------------------------------------------------------------
  if (!watcher.enabled) {
    lines.push(`${WARN} **Watcher** — disabled, set \`DISCORD_WATCH_CHANNEL_ID\` to auto-post games`);
  } else if (!watcher.running) {
    lines.push(`${BAD} **Watcher** — configured but not running`);
  } else {
    lines.push(
      `${OK} **Watcher** — ${watcher.phase.toLowerCase()}, next check in ${watcher.nextCheckSeconds}s ` +
        `· <#${watcher.channelId}>`
    );
  }

  // --- stored data ---------------------------------------------------------
  const lastScan = db.getMeta('lastScanAt');
  const lastGame = games.length > 0 ? games[games.length - 1].playedAt : null;
  lines.push(
    `${games.length > 0 ? OK : WARN} **Data** — ${games.length} game${games.length === 1 ? '' : 's'}, ` +
      `${players.length} player${players.length === 1 ? '' : 's'}` +
      (lastGame ? ` · last game <t:${Math.floor(lastGame / 1000)}:R>` : '')
  );
  lines.push(
    `-# ${dbPath} · ${db.skippedCount()} match(es) checked and rejected · ` +
      (lastScan ? `last scan <t:${Math.floor(lastScan / 1000)}:R>` : 'no scan since restart')
  );

  const healthy = !lines.some((l) => l.startsWith(BAD));
  const embed = new EmbedBuilder()
    .setTitle('🩺 Bot status')
    .setColor(healthy ? (lines.some((l) => l.startsWith(WARN)) ? 0xf1c40f : 0x2ecc71) : 0xe74c3c)
    .setDescription(lines.join('\n'))
    .setFooter({
      text:
        `${config.riotRegion}/${config.riotPlatform} · rolling window ${config.rollingWindow} · ` +
        `queues ${allowedQueues().join(', ')}`
    });

  await interaction.editReply({ embeds: [embed] });
}
