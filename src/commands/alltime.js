import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { computeCareerStats } from '../rollingStats.js';

const ROLE_EMOJI = {
  TOP: '🛡️',
  JUNGLE: '🌲',
  MIDDLE: '⚡',
  BOTTOM: '🏹',
  UTILITY: '💚',
  UNKNOWN: '❓'
};

const ROLE_LABEL = {
  TOP: 'Top',
  JUNGLE: 'Jungle',
  MIDDLE: 'Mid',
  BOTTOM: 'ADC',
  UTILITY: 'Support',
  UNKNOWN: 'Other'
};

const MEDALS = ['🥇', '🥈', '🥉'];

function scoreBar(score) {
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function rankLabel(i) {
  return MEDALS[i] || `**${i + 1}.**`;
}

/** One decimal everywhere, so 51 and 73.9 don't sit next to each other. */
const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');

/** Discord renders this in each viewer's own locale and timezone. */
function shortDate(ms) {
  return `<t:${Math.floor(ms / 1000)}:d>`;
}

function formTag(s) {
  if (s.formDelta === null) return null;
  if (s.formDelta >= 1.5) return `▲ +${fmt(s.formDelta)} recent`;
  if (s.formDelta <= -1.5) return `▼ ${fmt(s.formDelta)} recent`;
  return '▬ steady';
}

export const data = new SlashCommandBuilder()
  .setName('alltime')
  .setDescription('Overall leaderboard across every game the bot has ever scored.');

export async function execute(interaction) {
  const { stats, squadMean, totalGames, legacyGames, firstPlayed, lastPlayed } = computeCareerStats();

  if (stats.length === 0) {
    await interaction.reply('No scored games yet — run `/fetchgame` after your next match.');
    return;
  }

  const lines = stats.map((s, i) => {
    // Every role they've played, most-played first. Not truncated: there are only
    // five, and a capped list doesn't add up to the game count next to it.
    const roles = s.byRole
      .map((r) => `${ROLE_EMOJI[r.role] || '❓'} ${ROLE_LABEL[r.role] || r.role} ${fmt(r.rating)} ×${r.games}`)
      .join(' · ');

    const meta = [
      `${s.gamesPlayed} game${s.gamesPlayed === 1 ? '' : 's'}`,
      `${s.winRate}% W`,
      `best ${fmt(s.best)}`,
      `worst ${fmt(s.worst)}`,
      s.benched > 0 ? `benched ${s.benched}×` : null,
      formTag(s)
    ].filter(Boolean);

    return (
      `${rankLabel(i)} <@${s.discordId}> — \`${scoreBar(s.rating)}\` **${fmt(s.rating)}**\n` +
      `-# ${meta.join(' · ')}\n` +
      `-# ${roles}`
    );
  });

  const span = firstPlayed && lastPlayed ? ` · ${shortDate(firstPlayed)} – ${shortDate(lastPlayed)}` : '';

  const embed = new EmbedBuilder()
    .setTitle('🏆 All-time standings')
    .setColor(0xf1c40f)
    .setDescription(
      `Across all **${totalGames}** scored game${totalGames === 1 ? '' : 's'}${span}\n` +
        `-# Weighted by games played — a thin record sits near the squad average (${fmt(squadMean)}) until it's earned.\n\n` +
        lines.join('\n\n')
    )
    .setFooter({
      text: '50 = did your job for your role · /leaderboard for recent form · /profile for one player'
    });

  // Per-role averages are directly comparable to each other, so the squad's best
  // player at a role is a real answer rather than a stat artefact. Worth calling
  // out explicitly — it's the thing a rotation actually needs to know.
  //
  // Every role anyone has played shows up, including one-game samples. Hiding a
  // role until it clears some threshold reads as "nobody is good at Mid" rather
  // than "not enough games yet", and the ×N count already says how thin it is.
  const bestByRole = [];
  for (const role of ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']) {
    const contenders = stats
      .map((s) => ({ s, r: s.byRole.find((r) => r.role === role) }))
      .filter((c) => c.r)
      .sort((a, b) => b.r.rating - a.r.rating || b.r.games - a.r.games);
    if (contenders.length === 0) continue;
    const { s, r } = contenders[0];
    // Mentions, matching the list above — using Riot names here made the same
    // person appear under two different names in one embed.
    bestByRole.push(`${ROLE_EMOJI[role]} ${ROLE_LABEL[role]} — <@${s.discordId}> ${fmt(r.rating)} (×${r.games})`);
  }
  if (bestByRole.length > 0) {
    embed.addFields({ name: '🎯 Best in role', value: bestByRole.join('\n'), inline: false });
  }

  if (legacyGames > 0) {
    embed.addFields({
      name: '⚠️ Mixed scoring models',
      value:
        `-# ${legacyGames} of these game${legacyGames === 1 ? ' was' : 's were'} scored before the role-based rewrite ` +
        `and aren't directly comparable. \`/resetgames\` clears them if you want a clean slate.`,
      inline: false
    });
  }

  await interaction.reply({ embeds: [embed] });
}
