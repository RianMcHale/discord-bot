import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { computeRollingStats } from '../rollingStats.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription(`Recent form: each player's average over their own last ${config.rollingWindow} games.`);

export async function execute(interaction) {
  const { ranked, provisional, minGames } = computeRollingStats(config.rollingWindow, {
    minGames: config.leaderboardMinGames
  });

  if (ranked.length === 0 && provisional.length === 0) {
    await interaction.reply('No scored games yet — run `/fetchgame` after your next match.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`Recent form (last ${config.rollingWindow} games)`)
    .setColor(0x3498db)
    .setFooter({ text: 'Each player over their OWN last games · 50 = did your job for your role' });

  if (ranked.length > 0) {
    const best = [...ranked].sort((a, b) => b.rollingAverage - a.rollingAverage);
    embed.setDescription(
      best
        .map((s, i) => `**${i + 1}.** <@${s.discordId}> — **${s.rollingAverage}**/100 (${s.gamesPlayed} games)`)
        .join('\n')
    );
  } else {
    embed.setDescription(`Nobody has ${minGames} scored games yet, so there's no form to rank.`);
  }

  // Shown rather than hidden: "where is my name" is a worse question than
  // "how many more games until I show up".
  if (provisional.length > 0) {
    embed.addFields({
      name: `⏳ Not enough games yet (${minGames} needed)`,
      value: provisional
        .map((s) => `-# <@${s.discordId}> — ${s.gamesPlayed}/${minGames} · currently ${s.rollingAverage}`)
        .join('\n'),
      inline: false
    });
  }

  await interaction.reply({ embeds: [embed] });
}
