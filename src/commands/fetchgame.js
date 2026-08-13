import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { riot } from '../riotApi.js';
import { db } from '../storage.js';
import { scoreMatch } from '../scoring.js';

const ROLE_DISPLAY = {
  TOP: { label: 'Top', emoji: '🛡️' },
  JUNGLE: { label: 'Jungle', emoji: '🌲' },
  MIDDLE: { label: 'Mid', emoji: '⚡' },
  BOTTOM: { label: 'ADC', emoji: '🏹' },
  UTILITY: { label: 'Support', emoji: '💚' }
};

const ROLE_ORDER = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

function roleInfo(role) {
  return ROLE_DISPLAY[role] || { label: role, emoji: '❓' };
}

function scoreBar(score) {
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

// Pull recent match ids from EVERY registered player, not just one "anchor" —
// otherwise a game gets missed entirely whenever that one anchor player is the
// one sitting out the rotation for that match.
async function fetchAllCandidateMatchIds(players, lookback) {
  const idSet = new Set();
  for (const player of players) {
    try {
      const ids = await riot.getRecentMatchIds(player.puuid, lookback);
      ids.forEach((id) => idSet.add(id));
    } catch (err) {
      console.error(`Failed to fetch match history for ${player.riotGameName}#${player.riotTagLine}:`, err.message);
    }
  }
  return [...idSet];
}

export const data = new SlashCommandBuilder()
  .setName('fetchgame')
  .setDescription('Pull the most recent match your registered squad played together and score it.')
  .addIntegerOption((opt) =>
    opt.setName('lookback').setDescription('How many recent matches per player to search through (default 5)').setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const players = db.allPlayers();
  if (players.length < 2) {
    await interaction.editReply('Need at least 2 players registered with `/register` before I can score anything.');
    return;
  }

  const lookback = interaction.options.getInteger('lookback') || 5;
  const trackedPuuids = players.map((p) => p.puuid);

  try {
    const candidateIds = await fetchAllCandidateMatchIds(players, lookback);

    const skipped = [];
    const qualifying = []; // { matchId, match, timestamp }

    for (const matchId of candidateIds) {
      if (db.hasGame(matchId)) {
        skipped.push({ matchId, reason: 'already scored' });
        continue;
      }
      const match = await riot.getMatch(matchId);
      const participantsPuuids = match.info.participants.map((p) => p.puuid);
      const overlap = trackedPuuids.filter((puuid) => participantsPuuids.includes(puuid));
      if (overlap.length >= 2) {
        qualifying.push({
          matchId,
          match,
          timestamp: match.info.gameEndTimestamp || match.info.gameStartTimestamp || 0
        });
      } else {
        skipped.push({ matchId, reason: `only ${overlap.length} registered player(s) played` });
      }
    }

    if (qualifying.length === 0) {
      const skippedList = skipped.length
        ? '\n\nChecked and skipped:\n' + skipped.map((s) => `\`${s.matchId}\` — ${s.reason}`).join('\n')
        : '';
      await interaction.editReply(
        `No new shared matches found across the squad's last ${lookback} games each. Try increasing \`lookback\`.${skippedList}`
      );
      return;
    }

    // Most recent qualifying match wins, regardless of whose match list it came from.
    qualifying.sort((a, b) => b.timestamp - a.timestamp);
    const { matchId: chosenId, match: chosenMatch } = qualifying[0];
    const alsoNew = qualifying.length - 1;

    // scores includes BOTH teams — every player in the lobby, scored the same way.
    const scores = scoreMatch(chosenMatch, trackedPuuids);

    const byPuuid = Object.fromEntries(players.map((p) => [p.puuid, p]));
    const scoresByDiscordId = {};
    for (const [puuid, s] of Object.entries(scores)) {
      const player = byPuuid[puuid];
      if (player) scoresByDiscordId[player.discordId] = s;
    }

    // Store only the tracked squad's scores — that's all rolling averages need.
    db.saveGame(chosenId, {
      matchId: chosenId,
      playedAt: chosenMatch.info.gameEndTimestamp || chosenMatch.info.gameStartTimestamp || Date.now(),
      queueId: chosenMatch.info.queueId,
      durationSeconds: chosenMatch.info.gameDuration,
      scores: scoresByDiscordId
    });

    const sorted = Object.entries(scoresByDiscordId).sort((a, b) => b[1].composite - a[1].composite);
    const worstDiscordId = sorted[sorted.length - 1][0];
    const win = sorted[0][1].win;
    const squadTeamId = sorted[0][1].teamId;

    const embed = new EmbedBuilder()
      .setTitle(`${win ? '🏆 Victory' : '💀 Defeat'} · ${Math.round(chosenMatch.info.gameDuration / 60)} min`)
      .setDescription(
        `Match \`${chosenId}\` · objective scoring only — run \`/vote\` to factor in teammate impact ratings.`
      )
      .setColor(win ? 0x2ecc71 : 0xe74c3c);

    for (const [discordId, s] of sorted) {
      const isWorst = discordId === worstDiscordId;
      const { label, emoji } = roleInfo(s.role);
      embed.addFields({
        name: `${emoji} ${label}${isWorst ? ' 🔻 Worst' : ''}`,
        value:
          `<@${discordId}> — **${s.champion}**\n` +
          `\`${scoreBar(s.composite)}\` **${s.composite}**\n` +
          `KDA ${s.kda}\n` +
          `-# KP ${s.breakdown.killParticipation} · Dmg/Gold ${s.breakdown.dmgGoldEfficiency} · Vision/Obj ${s.breakdown.visionObjective} · Deaths ${s.breakdown.deathsInverse}`,
        inline: true
      });
    }

    embed.addFields({
      name: '🪑 On probation',
      value: `<@${worstDiscordId}> — check \`/leaderboard\` before benching; one bad game shouldn't outweigh a good rolling average.`,
      inline: false
    });

    // Compact enemy-team line: role, champion, score — nothing else.
    const enemyEntries = Object.values(scores)
      .filter((s) => s.teamId !== squadTeamId)
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));

    if (enemyEntries.length > 0) {
      embed.addFields({
        name: '⚔️ Enemy team',
        value: enemyEntries
          .map((e) => `${roleInfo(e.role).emoji} ${roleInfo(e.role).label} · ${e.champion} — **${e.composite}**`)
          .join('\n'),
        inline: false
      });
    }

    if (alsoNew > 0) {
      embed.addFields({
        name: 'ℹ️ Heads up',
        value: `${alsoNew} other new shared match(es) found too — run \`/fetchgame\` again to score the next one.`,
        inline: false
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    const status = err?.response?.status;
    if (status === 403) {
      await interaction.editReply('Riot API rejected the request (403). Your RIOT_API_KEY may be missing or expired.');
    } else if (status === 429) {
      await interaction.editReply('Rate limited by the Riot API — wait a bit and try again.');
    } else {
      console.error(err);
      await interaction.editReply(`Something went wrong: ${err.message}`);
    }
  }
}