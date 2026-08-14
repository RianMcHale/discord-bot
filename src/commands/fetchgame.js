import { SlashCommandBuilder } from 'discord.js';
import { scanForNewGames } from '../scanner.js';
import { buildMatchEmbed, postScorecards } from '../embeds.js';

// Discord's 6000-character embed limit is the total across every embed in a
// MESSAGE, not per embed. Five scorecards in one reply exceeds it and the whole
// send is rejected, so each game is posted as its own message.
const MAX_PER_RUN = 5;

export const data = new SlashCommandBuilder()
  .setName('fetchgame')
  .setDescription('Score the most recent match your registered squad played together.')
  .addIntegerOption((opt) =>
    opt.setName('lookback').setDescription('How many recent matches per player to search through (default 5)').setRequired(false)
  )
  .addIntegerOption((opt) =>
    opt
      .setName('count')
      .setDescription(`Score more than just the latest game, newest first (max ${MAX_PER_RUN})`)
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
  const maxToScore = interaction.options.getInteger('count') || 1;
  const detail = interaction.options.getBoolean('detail') || false;

  try {
    const result = await scanForNewGames({ lookback, maxToScore, order: 'newest' });

    if (result.tooFewPlayers) {
      await interaction.editReply('Need at least 2 players registered with `/register` before I can score anything.');
      return;
    }

    // A scan that fetched nothing because Riot rejected every call is not the
    // same as a scan that found no new games, and must not read like one.
    if (result.scored.length === 0 && result.apiErrors?.length === result.players.length) {
      const first = result.apiErrors[0];
      const hint =
        first.status === 403
          ? 'The `RIOT_API_KEY` is invalid or expired — development keys last 24 hours.'
          : first.status === 429
            ? 'Rate limited by Riot. Wait a couple of minutes.'
            : 'Riot rejected the request. Check the bot logs for detail.';
      await interaction.editReply(
        `⚠️ Could not read match history for **any** registered player (${first.detail}).\n${hint}`
      );
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

    await postScorecards(interaction, embeds);
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
