import { SlashCommandBuilder } from 'discord.js';
import { scanForNewGames } from '../scanner.js';
import { buildMatchEmbed } from '../embeds.js';

// Discord allows 10 embeds per message; scoring costs two Riot calls per match,
// so this caps both at something comfortable.
const MAX_PER_RUN = 5;

export const data = new SlashCommandBuilder()
  .setName('fetchgame')
  .setDescription('Score every new match your registered squad has played together.')
  .addIntegerOption((opt) =>
    opt.setName('lookback').setDescription('How many recent matches per player to search through (default 5)').setRequired(false)
  )
  .addIntegerOption((opt) =>
    opt
      .setName('count')
      .setDescription(`How many new games to score this run (default ${MAX_PER_RUN}, max ${MAX_PER_RUN})`)
      .setMinValue(1)
      .setMaxValue(MAX_PER_RUN)
      .setRequired(false)
  )
  .addBooleanOption((opt) =>
    opt.setName('detail').setDescription("Show every player's full per-role breakdown instead of the summary").setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const lookback = interaction.options.getInteger('lookback') || 5;
  const maxToScore = interaction.options.getInteger('count') || MAX_PER_RUN;
  const detail = interaction.options.getBoolean('detail') || false;

  try {
    const result = await scanForNewGames({ lookback, maxToScore });

    if (result.tooFewPlayers) {
      await interaction.editReply('Need at least 2 players registered with `/register` before I can score anything.');
      return;
    }

    if (result.scored.length === 0) {
      const reasons = Object.entries(result.skippedReasons)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, n]) => `-# ${n}× ${reason}`)
        .join('\n');
      const cachedNote = result.cached > 0 ? `\n-# ${result.cached} already checked previously — not re-fetched` : '';

      await interaction.editReply(
        `No new **Summoner's Rift** matches found across the squad's last ${lookback} games each. ` +
          'Try increasing `lookback`.' +
          (reasons ? `\n${reasons}` : '') +
          cachedNote
      );
      return;
    }

    // Oldest first, so a backlog reads in the order it was played. Only the last
    // embed carries the "more still queued" note.
    const embeds = result.scored.map((game, i) =>
      buildMatchEmbed({
        scores: game.scores,
        scoresByDiscordId: game.scoresByDiscordId,
        nameByDiscordId: game.nameByDiscordId,
        matchInfo: game.match.info,
        hasTimeline: game.hasTimeline,
        detail,
        alsoNew: i === result.scored.length - 1 ? result.remaining : 0
      }).embed
    );

    await interaction.editReply({ embeds });
  } catch (err) {
    const status = err?.response?.status;
    if (status === 403) {
      await interaction.editReply('Riot API rejected the request (403). Your RIOT_API_KEY may be missing or expired.');
    } else if (status === 429) {
      await interaction.editReply('Rate limited by the Riot API — wait a bit and try again.');
    } else {
      console.error(err);
      await interaction.editReply(`Something went wrong: ${err.message}`);
    }
  }
}
