import { SlashCommandBuilder } from 'discord.js';
import { riot } from '../riotApi.js';
import { db } from '../storage.js';

export const data = new SlashCommandBuilder()
  .setName('register')
  .setDescription('Link your Discord account to your Riot ID so games can be tracked.')
  .addStringOption((opt) => opt.setName('game_name').setDescription('Riot ID name part, e.g. "Faker"').setRequired(true))
  .addStringOption((opt) => opt.setName('tag_line').setDescription('Riot ID tag part, e.g. "KR1" (without the #)').setRequired(true))
  .addUserOption((opt) => opt.setName('user').setDescription('(Admin) register someone else').setRequired(false));

export async function execute(interaction) {
  await interaction.deferReply();

  const gameName = interaction.options.getString('game_name');
  const tagLine = interaction.options.getString('tag_line').replace(/^#/, '');
  const targetUser = interaction.options.getUser('user') || interaction.user;

  try {
    const account = await riot.getAccountByRiotId(gameName, tagLine);
    const player = db.upsertPlayer({
      discordId: targetUser.id,
      riotGameName: account.gameName,
      riotTagLine: account.tagLine,
      puuid: account.puuid,
      addedAt: Date.now()
    });

    await interaction.editReply(
      `✅ Linked **${targetUser.username}** to Riot ID **${player.riotGameName}#${player.riotTagLine}**.`
    );
  } catch (err) {
    const status = err?.response?.status;
    if (status === 404) {
      await interaction.editReply(`Couldn't find a Riot account for **${gameName}#${tagLine}**. Check the spelling.`);
    } else if (status === 403) {
      await interaction.editReply(`Riot API rejected the request (403). Your RIOT_API_KEY may be missing or expired.`);
    } else {
      console.error(err);
      await interaction.editReply(`Something went wrong looking that up: ${err.message}`);
    }
  }
}
