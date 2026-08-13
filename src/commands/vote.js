import { SlashCommandBuilder } from 'discord.js';
import { db } from '../storage.js';

export const data = new SlashCommandBuilder()
  .setName('vote')
  .setDescription("Rate a teammate's impact (1-5) for the most recently scored game.")
  .addUserOption((opt) => opt.setName('player').setDescription('Who you are rating').setRequired(true))
  .addIntegerOption((opt) =>
    opt.setName('rating').setDescription('1 (threw) to 5 (carried)').setMinValue(1).setMaxValue(5).setRequired(true)
  );

export async function execute(interaction) {
  const games = db.allGames();
  if (games.length === 0) {
    await interaction.reply({ content: 'No games scored yet — run `/fetchgame` first.', ephemeral: true });
    return;
  }
  const latest = games[games.length - 1];
  const target = interaction.options.getUser('player');
  const rating = interaction.options.getInteger('rating');

  if (!latest.scores[target.id]) {
    await interaction.reply({
      content: `<@${target.id}> wasn't tracked in the most recently scored game, so there's nothing to vote on.`,
      ephemeral: true
    });
    return;
  }
  if (target.id === interaction.user.id) {
    await interaction.reply({ content: "You can't vote on yourself.", ephemeral: true });
    return;
  }

  db.addVote(latest.matchId, interaction.user.id, target.id, rating);
  await interaction.reply(`Recorded: ${'⭐'.repeat(rating)} for <@${target.id}> on match \`${latest.matchId}\`.`);
}
