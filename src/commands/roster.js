import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { db } from '../storage.js';

export const data = new SlashCommandBuilder().setName('roster').setDescription('List everyone currently registered.');

export async function execute(interaction) {
  const players = db.allPlayers();
  if (players.length === 0) {
    await interaction.reply('Nobody registered yet — use `/register` to add players.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`Roster (${players.length})`)
    .setColor(0x1abc9c)
    .setDescription(players.map((p) => `<@${p.discordId}> — ${p.riotGameName}#${p.riotTagLine}`).join('\n'));

  await interaction.reply({ embeds: [embed] });
}
