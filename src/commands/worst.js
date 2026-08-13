import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { computeRollingStats } from '../rollingStats.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('worst')
  .setDescription('Show who should be benched based on rolling average performance.');

export async function execute(interaction) {
  const stats = computeRollingStats(config.rollingWindow);

  if (stats.length === 0) {
    await interaction.reply('No scored games yet — run `/fetchgame` after your next match.');
    return;
  }

  const worst = stats[0]; // already sorted ascending
  const small = worst.gamesPlayed < 3;

  const embed = new EmbedBuilder()
    .setTitle('Bench recommendation')
    .setColor(0xe67e22)
    .setDescription(
      `<@${worst.discordId}> has the lowest rolling average: **${worst.rollingAverage}**/100 over ${worst.gamesPlayed} game(s).` +
        (small ? `\n⚠️ Small sample size — this could swing hard after one more game.` : '')
    )
    .addFields({
      name: 'Recent scores',
      value: worst.recentScores.map((s) => s.toFixed(1)).join(', ')
    });

  await interaction.reply({ embeds: [embed] });
}
