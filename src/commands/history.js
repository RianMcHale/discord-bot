import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { db } from '../storage.js';
import { finalScoreWithVotes } from '../scoring/index.js';

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
    const votes = db.votesForGame(g.matchId);
    const ratings = Object.values(votes)
      .map((byTarget) => byTarget[targetUser.id])
      .filter((r) => typeof r === 'number');
    const avgVote = ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null;
    const final = finalScoreWithVotes(s.composite, avgVote);
    const date = new Date(g.playedAt).toLocaleDateString();
    // Games scored before the role-based rewrite have no grade stored.
    const gradeTag = s.grade ? ` (${s.grade})` : '';
    return `\`${date}\` ${s.role} · KDA ${s.kda} · ${s.win ? 'W' : 'L'} · score **${final.toFixed(1)}**${gradeTag}${
      avgVote ? ` · votes ${avgVote.toFixed(1)}⭐` : ''
    }`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`${player.riotGameName}#${player.riotTagLine} — recent games`)
    .setColor(0x9b59b6)
    .setDescription(lines.join('\n'));

  await interaction.reply({ embeds: [embed] });
}
