import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { computeCareerStats } from '../rollingStats.js';

const ROLE_EMOJI = { TOP: '🛡️', JUNGLE: '🌲', MIDDLE: '⚡', BOTTOM: '🏹', UTILITY: '💚', UNKNOWN: '❓' };
const ROLE_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support', UNKNOWN: 'Other' };
const ROLE_ORDER = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY', 'UNKNOWN'];

// Rolling windows rather than calendar ones, matching /alltime: "this month" is
// empty on the 1st, whereas "the last 30 days" always covers real play.
const PERIODS = {
  week: { label: 'last 7 days', title: 'Last 7 days', days: 7 },
  month: { label: 'last 30 days', title: 'Last 30 days', days: 30 }
};

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

/** Proportional bar, so the eye can compare rows without reading the numbers. */
function bar(value, max, width = 10) {
  if (!(max > 0)) return '▱'.repeat(width);
  const filled = Math.max(value > 0 ? 1 : 0, Math.round((value / max) * width));
  return '▰'.repeat(filled) + '▱'.repeat(Math.max(0, width - filled));
}

export const data = new SlashCommandBuilder()
  .setName('benched')
  .setDescription('Who has been benched most, and which roles get benched most.')
  .addStringOption((opt) =>
    opt
      .setName('period')
      .setDescription('Limit to a recent stretch instead of the full record')
      .addChoices({ name: 'Last 7 days', value: 'week' }, { name: 'Last 30 days', value: 'month' })
      .setRequired(false)
  );

export async function execute(interaction) {
  const period = PERIODS[interaction.options.getString('period')] ?? null;
  const since = period ? Date.now() - period.days * 86400000 : null;


  // minGames 1: this is a count of things that happened, not a ranking of form.
  // Hiding someone benched once because they have only two games would be
  // hiding the exact fact being asked for.
  const { stats, provisional, benchByRole, benchableGames, totalGames, squadMean } = computeCareerStats(5, {
    minGames: 1,
    since
  });

  if (totalGames === 0) {
    await interaction.reply(period ? `No games scored in the ${period.label}.` : 'No scored games yet — run `/fetchgame` after your next match.');
    return;
  }

  const everyone = [...stats, ...provisional].sort(
    (a, b) => b.benched - a.benched || pct(b.benched, b.gamesPlayed) - pct(a.benched, a.gamesPlayed)
  );
  const totalBenched = everyone.reduce((s, p) => s + p.benched, 0);

  // A bench call needs two tracked players in the game to mean anything, so
  // games with only one of the squad in them are not part of the denominator.
  if (benchableGames === 0) {
    await interaction.reply(
      `**${totalGames}** game${totalGames === 1 ? '' : 's'} scored, but none had two or more registered players in them — ` +
        'there was never anyone to be worst *of*.'
    );
    return;
  }

  // --- roles, at the top ----------------------------------------------------
  const roleRows = [...benchByRole].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
  );
  const worstRole = Math.max(...roleRows.map((r) => r.benched), 0);

  const roleLines = roleRows.map((r) => {
    const rate = pct(r.benched, r.played);
    // Discord renders in a proportional font, so padding inside the label buys
    // nothing and trailing spaces inside `**` stop the bold rendering at all.
    // The code-fenced bar is the fixed-width part that lines the rows up.
    return (
      `${ROLE_EMOJI[r.role] || '❓'} \`${bar(r.benched, worstRole)}\` **${r.benched}×** ${ROLE_LABEL[r.role] || r.role}\n` +
      `-# ${rate}% of ${r.played} game${r.played === 1 ? '' : 's'} played in the role`
    );
  });

  // --- people ---------------------------------------------------------------
  const worstPerson = Math.max(...everyone.map((p) => p.benched), 0);
  const peopleLines = everyone.map((p, i) => {
    const rate = pct(p.benched, p.gamesPlayed);
    const roles = p.benchedByRole
      .map((r) => `${ROLE_EMOJI[r.role] || '❓'}${r.benched}`)
      .join(' ');
    const meta = [
      `${p.benched}/${p.gamesPlayed} game${p.gamesPlayed === 1 ? '' : 's'} (${rate}%)`,
      roles || null,
      p.benched === 0 ? 'never benched' : null
    ].filter(Boolean);
    return (
      `**${i + 1}.** <@${p.discordId}> — \`${bar(p.benched, worstPerson)}\` **${p.benched}×**\n` +
      `-# ${meta.join(' · ')}`
    );
  });

  const scope = period ? `the ${period.label}` : 'the full record';
  const embed = new EmbedBuilder()
    .setTitle(period ? `🪑 Bench count · ${period.title}` : '🪑 Bench count')
    .setColor(0xe67e22)
    .setDescription(
      `**${totalBenched}** bench call${totalBenched === 1 ? '' : 's'} across **${benchableGames}** ` +
        `game${benchableGames === 1 ? '' : 's'} with two or more of you in them, over ${scope}.\n` +
        `-# The worst score in each game is the bench call. Squad average is ${squadMean.toFixed(1)}.`
    );

  if (roleLines.length > 0) {
    embed.addFields({ name: '📍 By role', value: roleLines.join('\n'), inline: false });
  }

  // 1024 characters per field value. Split rather than truncate — a bench
  // tally that silently drops the bottom of the list is worse than two fields.
  const chunks = [];
  let current = [];
  for (const line of peopleLines) {
    const next = [...current, line].join('\n');
    if (next.length > 1000 && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) chunks.push(current.join('\n'));

  chunks.forEach((value, i) => {
    embed.addFields({ name: i === 0 ? '👤 By player' : '​', value, inline: false });
  });

  if (benchableGames < totalGames) {
    const solo = totalGames - benchableGames;
    embed.addFields({
      name: '​',
      value: `-# ${solo} further game${solo === 1 ? ' had' : 's had'} only one registered player, so no bench call was possible.`,
      inline: false
    });
  }

  embed.setFooter({ text: 'Being benched means finishing last among registered players · /worst for the current call' });

  await interaction.reply({ embeds: [embed] });
}
