import { SlashCommandBuilder } from 'discord.js';
import { db } from '../storage.js';

export const data = new SlashCommandBuilder()
  .setName('resetgames')
  .setDescription('Wipe all scored game history and votes. Keeps registered players. Cannot be undone.')
  .addStringOption((opt) =>
    opt
      .setName('confirm')
      .setDescription('Type RESET to confirm')
      .setRequired(true)
  );

export async function execute(interaction) {
  const confirm = interaction.options.getString('confirm');
  if (confirm !== 'RESET') {
    await interaction.reply({
      content: 'Not reset — you must type `RESET` exactly in the confirm field to proceed.',
      ephemeral: true
    });
    return;
  }

  db.resetGames();
  await interaction.reply('✅ Game history and votes cleared. Registered players were kept. Next `/fetchgame` starts fresh.');
}