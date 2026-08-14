import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { db } from '../storage.js';

const ROLE_EMOJI = {
  TOP: '🛡️',
  JUNGLE: '🌲',
  MIDDLE: '⚡',
  BOTTOM: '🏹',
  UTILITY: '💚'
};

export const data = new SlashCommandBuilder()
  .setName('history')
  .setDescription("Show a player's recent scored games.")
  .addUserOption((opt) => opt.setName('player').setDescription('Whose history to show (default: you)').setRequired(false))
  .addIntegerOption((opt) => opt.setName('count').setDescription('How many games to show (default 10)').setRequired(false));

export async function execute(interaction) {
  const targetUser = interaction.options.getUser('player') || interaction.user;
  const count = interaction.options.getInteger('count') || 10;

  const player = db.getPlayer(targetUser.id);
  if (!player) {
    await interaction.reply({ content: `<@${targetUser.id}> hasn't run \`/register\` yet.`, ephemeral: true });
    return;
  }

  const games = db.gamesForPlayer(targetUser.id, count);
  if (games.length === 0) {
    await interaction.reply(`No scored games yet for <@${targetUser.id}>.`);
    return;
  }

  const lines = games.map((g) => {
    const s = g.scores[targetUser.id];
    // Games scored before the role-based rewrite have no grade stored.
    const gradeTag = s.grade ? ` (${s.grade})` : '';
    const emoji = ROLE_EMOJI[s.role] || '❓';
    return (
      `<t:${Math.floor(g.playedAt / 1000)}:d> ${emoji} **${s.champion}** · ` +
      `${s.win ? 'W' : 'L'} · KDA ${s.kda} · **${s.composite.toFixed(1)}**${gradeTag}`
    );
  });

  const embed = new EmbedBuilder()
    .setTitle(`${player.riotGameName}#${player.riotTagLine} — recent games`)
    .setColor(0x9b59b6)
    .setDescription(lines.join('\n'))
    .setFooter({ text: '50 = did your job for your role · /profile for the full picture' });

  await interaction.reply({ embeds: [embed] });
}
