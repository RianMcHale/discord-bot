import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { rescoreStored, coverage } from '../rescore.js';
import { calibrationVersion } from '../scoring/calibration.js';
import * as rawArchive from '../rawArchive.js';
import { isAdmin } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('rescore')
  .setDescription('Re-score stored games with the current model, from the archive. No Riot API calls. Restricted.')
  .addIntegerOption((opt) =>
    opt.setName('last').setDescription('Only the N most recent games').setMinValue(1).setRequired(false)
  )
  .addBooleanOption((opt) =>
    opt
      .setName('preview')
      .setDescription('Show what would change without writing anything (default: true)')
      .setRequired(false)
  );

export async function execute(interaction) {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({
      content: '`/rescore` rewrites stored scores, so it is restricted to the bot owner.',
      ephemeral: true
    });
    return;
  }

  const last = interaction.options.getInteger('last');
  // Defaults to a preview. Rewriting every stored score is the kind of thing you
  // want to see the shape of first, and the run costs nothing to repeat.
  const preview = interaction.options.getBoolean('preview') ?? true;

  const cov = coverage();
  if (!rawArchive.enabled()) {
    await interaction.reply(
      'Archiving is off (`ARCHIVE_RAW=0`), so there are no payloads to re-score from.\n' +
        '-# Turn it on and new games will be archived as they are scored.'
    );
    return;
  }
  if (cov.covered === 0) {
    await interaction.reply(
      `None of the ${cov.stored} stored games have an archived payload yet.\n` +
        '-# Archiving started recently, so games scored before that cannot be re-scored — they stay as they are. New ones can.'
    );
    return;
  }

  await interaction.deferReply();
  const result = await rescoreStored({ last, dryRun: preview });

  const changed = result.rescored;
  const embed = new EmbedBuilder()
    .setTitle(preview ? 'Re-score preview' : 'Re-scored')
    .setColor(preview ? 0x95a5a6 : 0x1b6b5a)
    .setDescription(
      preview
        ? `**${changed}** of ${result.considered} stored games would change under the current model. Nothing has been written.\n` +
            '-# Run again with `preview:false` to apply it.'
        : `**${changed}** of ${result.considered} stored games re-scored under the current model.`
    )
    .addFields({
      name: 'Coverage',
      value:
        `${cov.covered} of ${cov.stored} stored games have an archived payload (${cov.pct}%)` +
        (result.missingPayload > 0
          ? `\n-# ${result.missingPayload} left untouched — scored before archiving existed, so the inputs are gone.`
          : ''),
      inline: false
    });

  if (result.movers.length) {
    embed.addFields({
      name: 'Biggest changes',
      value: result.movers
        .map(
          (m) =>
            `<@${m.discordId}> **${m.delta > 0 ? '+' : ''}${m.delta}** · <t:${Math.floor(m.playedAt / 1000)}:d>`
        )
        .join('\n'),
      inline: false
    });
  } else if (changed === 0) {
    embed.addFields({
      name: 'Biggest changes',
      value: '-# None. Every archived game already scores the same under the current model.',
      inline: false
    });
  }

  if (result.failed.length) {
    embed.addFields({
      name: '⚠️ Would no longer score',
      value:
        result.failed
          .slice(0, 3)
          .map((f) => `-# \`${f.matchId}\` — ${f.reason}`)
          .join('\n') +
        (result.failed.length > 3 ? `\n-# …and ${result.failed.length - 3} more` : '') +
        '\n-# A game the model used to accept and now refuses is worth looking at.',
      inline: false
    });
  }

  const a = rawArchive.stats();
  embed.setFooter({
    text:
      `Calibration ${calibrationVersion() ?? 'none'} · archive ${a.games} games, ${a.mb} MB (${a.perGameKb} KB each)\n` +
      'No Riot API calls were made.'
  });

  await interaction.editReply({ embeds: [embed] });
}
