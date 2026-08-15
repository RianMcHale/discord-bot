import { SlashCommandBuilder } from 'discord.js';
import { db } from '../storage.js';
import { isAdmin } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('resetgames')
  .setDescription('Wipe all scored game history. Keeps registered players. Cannot be undone. Restricted.')
  .addStringOption((opt) => opt.setName('confirm').setDescription('Type RESET to confirm').setRequired(true));

export async function execute(interaction) {
  // Checked before the confirmation text: someone without permission shouldn't
  // learn whether they got the magic word right.
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({
      content:
        "`/resetgames` wipes everyone's history and can't be undone, so it's restricted to the bot owner.",
      ephemeral: true
    });
    return;
  }

  if (interaction.options.getString('confirm') !== 'RESET') {
    await interaction.reply({
      content: 'Not reset — you must type `RESET` exactly in the confirm field to proceed.',
      ephemeral: true
    });
    return;
  }

  const removed = db.allGames().length;
  db.resetGames();
  await interaction.reply({
    content:
      `✅ Cleared **${removed}** scored game${removed === 1 ? '' : 's'}. Registered players were kept. ` +
      'Next `/fetchgame` starts fresh.'
  });
}
