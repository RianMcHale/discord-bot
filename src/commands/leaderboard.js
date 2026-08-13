import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { computeRollingStats } from '../rollingStats.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription(`Show each player's rolling average score over their last ${config.rollingWindow} games.`);

export async function execute(interaction) {
  const stats = computeRollingStats(config.rollingWindow);

  if (stats.length === 0) {
    await interaction.reply('No scored games yet — run `/fetchgame` after your next match.');
    return;
  }

  const best = [...stats].sort((a, b) => b.rollingAverage - a.rollingAverage);

  const embed = new EmbedBuilder()
    .setTitle(`Rolling leaderboard (last ${config.rollingWindow} games)`)
    .setColor(0x3498db)
    .setDescription(
      best
        .map((s, i) => `**${i + 1}.** <@${s.discordId}> — **${s.rollingAverage}**/100 (${s.gamesPlayed} games)`)
        .join('\n')
    )
    .setFooter({ text: 'Scored per role against the enemy player in that role. 50 = did your job.' });

  await interaction.reply({ embeds: [embed] });
}
