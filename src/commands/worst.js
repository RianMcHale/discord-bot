import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { computeRollingStats } from '../rollingStats.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('worst')
  .setDescription('Show who should be benched based on recent form.');

export async function execute(interaction) {
  const { ranked, provisional, minGames } = computeRollingStats(config.rollingWindow, {
    minGames: config.leaderboardMinGames
  });

  if (ranked.length === 0 && provisional.length === 0) {
    await interaction.reply('No scored games yet — run `/fetchgame` after your next match.');
    return;
  }

  // The minimum matters most here. Benching someone off one or two games is
  // acting on noise, and it's the one thing this command exists to get right.
  if (ranked.length === 0) {
    const closest = provisional
      .map((s) => `-# <@${s.discordId}> — ${s.gamesPlayed}/${minGames}`)
      .join('\n');
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('No bench call yet')
          .setColor(0x95a5a6)
          .setDescription(
            `Nobody has ${minGames} scored games, which isn't enough form to bench anyone on.\n${closest}`
          )
      ]
    });
    return;
  }

  const worst = ranked[0]; // sorted ascending
  const runnerUp = ranked[1] ?? null;
  const margin = runnerUp ? Math.round((runnerUp.rollingAverage - worst.rollingAverage) * 10) / 10 : null;

  const embed = new EmbedBuilder()
    .setTitle('🪑 Bench recommendation')
    .setColor(0xe67e22)
    .setDescription(
      `<@${worst.discordId}> has the lowest recent form: **${worst.rollingAverage}**/100 ` +
        `over their last ${worst.gamesPlayed} game${worst.gamesPlayed === 1 ? '' : 's'}.` +
        // A one-point gap is a coin flip, not a verdict.
        (margin !== null && margin < 2
          ? `\n⚠️ Only ${margin} ahead of <@${runnerUp.discordId}> — too close to call.`
          : margin !== null
            ? `\n-# ${margin} behind <@${runnerUp.discordId}>.`
            : '')
    )
    .addFields({
      name: 'Recent scores',
      value: worst.recentScores.map((s) => s.toFixed(1)).join(' · '),
      inline: false
    })
    .setFooter({ text: `Ranked over each player's own last ${config.rollingWindow} games · minimum ${minGames}` });

  if (provisional.length > 0) {
    embed.addFields({
      name: `⏳ Not eligible (${minGames} games needed)`,
      value: provisional.map((s) => `-# <@${s.discordId}> — ${s.gamesPlayed}/${minGames}`).join('\n'),
      inline: false
    });
  }

  await interaction.reply({ embeds: [embed] });
}
