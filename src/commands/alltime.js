import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { computeCareerStats } from '../rollingStats.js';
import { config } from '../config.js';

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

// Rolling windows rather than calendar ones: "this month" is empty on the 1st
// and misleading on the 2nd, whereas "the last 30 days" always covers a real
// stretch of play whenever the command is run.
const PERIODS = {
  week: { label: 'Last 7 days', days: 7, title: '📅 Last 7 days' },
  month: { label: 'Last 30 days', days: 30, title: '📅 Last 30 days' }
};

export const data = new SlashCommandBuilder()
  .setName('alltime')
  .setDescription('Overall leaderboard across every game the bot has ever scored.')
  .addStringOption((opt) =>
    opt
      .setName('period')
      .setDescription('Limit to a recent stretch instead of the full record')
      .addChoices(
        { name: 'Last 7 days', value: 'week' },
        { name: 'Last 30 days', value: 'month' }
      )
      .setRequired(false)
  );

export async function execute(interaction) {
  const period = PERIODS[interaction.options.getString('period')] ?? null;
  const since = period ? Date.now() - period.days * 86400000 : null;

  const { stats, provisional, minGames, squadMean, totalGames, legacyGames, firstPlayed, lastPlayed } =
    computeCareerStats(5, { minGames: config.alltimeMinGames, since });

  if (period && totalGames === 0) {
    await interaction.reply(`No games scored in the ${period.label.toLowerCase()}.`);
    return;
  }

  if (stats.length === 0 && provisional.length === 0) {
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

  // Discord rejects the whole message if the description passes 4096 characters,
  // which at ~190 per player means a roster of about 21. Trim to what fits rather
  // than failing to send anything at all.
  const DESCRIPTION_LIMIT = 4096;
  const scope = period
    ? `**${totalGames}** game${totalGames === 1 ? '' : 's'} in the ${period.label.toLowerCase()}`
    : `all **${totalGames}** scored game${totalGames === 1 ? '' : 's'}`;
  const header =
    `Across ${scope}${span}\n` +
    `-# Weighted by games played — a thin record sits near the squad average (${fmt(squadMean)}) until it's earned.\n\n`;
  let shown = lines.length;
  const fits = () => header.length + lines.slice(0, shown).join('\n\n').length + 80 <= DESCRIPTION_LIMIT;
  while (shown > 1 && !fits()) shown -= 1;
  const trimmed = shown < lines.length ? `\n\n-# …and ${lines.length - shown} more — use \`/profile\`.` : '';

  const embed = new EmbedBuilder()
    .setTitle(period ? period.title : '🏆 All-time standings')
    .setColor(period ? 0x9b59b6 : 0xf1c40f)
    .setDescription(
      stats.length > 0
        ? header + lines.slice(0, shown).join('\n\n') + trimmed
        : `${header}Nobody has ${minGames} games${period ? ` in the ${period.label.toLowerCase()}` : ' yet'}, so there's no board to rank.`
    )
    .setFooter({
      text: period
        ? `50 = did your job for your role · /alltime with no period for the full record`
        : '50 = did your job for your role · /leaderboard for recent form · /profile for one player'
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

  // Listed rather than hidden: "where is my name" is a worse question than
  // "how many more games until I'm on the board".
  if (provisional.length > 0) {
    embed.addFields({
      name: `⏳ Not ranked yet (${minGames} games needed)`,
      value: provisional
        .map((s) => `-# <@${s.discordId}> — ${s.gamesPlayed}/${minGames} · currently ${fmt(s.rating)}`)
        .join('\n'),
      inline: false
    });
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
