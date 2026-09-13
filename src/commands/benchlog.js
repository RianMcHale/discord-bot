import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { db } from '../storage.js';
import { calibrationVersion } from '../scoring/calibration.js';

// What /worst actually said, and when (spec §12.4).
//
// Not /benched, which is a different question. /benched counts who finished
// lowest in each game, and it recomputes that from today's scores — so after a
// /rescore its history quietly changes. This is the other kind of record: the
// verdicts the bot gave, copied at the moment it gave them, with the ranges and
// reasons it showed. It is what makes an argument six weeks later resolvable.
export const data = new SlashCommandBuilder()
  .setName('benchlog')
  .setDescription('The bench calls /worst has made, exactly as it made them.')
  .addUserOption((opt) => opt.setName('player').setDescription('Only calls that named this player').setRequired(false));

// Plain text, not a Discord <t:> timestamp: those only render in field values,
// and this goes in a field name, where it would show as raw markup.
const when = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const range = (n) => `${n.rating} \`[${n.low} – ${n.high}]\``;

export async function execute(interaction) {
  const target = interaction.options.getUser('player');
  const entries = db.benchLog({ discordId: target?.id ?? null, limit: 8 });

  if (entries.length === 0) {
    await interaction.reply(
      target
        ? `/worst has never named <@${target.id}>.`
        : 'No bench calls recorded yet — `/worst` records one each time it gives a verdict.'
    );
    return;
  }

  const current = calibrationVersion();
  const embed = new EmbedBuilder()
    .setTitle(target ? 'Bench calls naming this player' : 'Bench calls')
    .setColor(0x7c8a86)
    .setDescription(
      'Each is exactly what `/worst` said at the time. The scores behind it may have been re-scored since — these do not change when that happens.'
    );

  for (const e of entries) {
    const who = e.named.map((n) => `<@${n.discordId}> ${range(n)}`).join('\n');
    const lines = [who];

    if (e.decisive && e.runnerUp) lines.push(`-# next lowest <@${e.runnerUp.discordId}> at ${range(e.runnerUp)}`);
    if (!e.decisive && e.overlap != null) lines.push(`-# ranges overlapped ${e.overlap}%, so nobody was named`);
    if (e.reasons?.length) {
      lines.push(`-# reasons given: ${e.reasons.map((r) => `${r.label} ${r.mine} vs squad ${r.squad}`).join(' · ')}`);
    }
    // Said plainly when the model has moved on since, because that is exactly
    // the case where today's numbers would tell a different story.
    const stale = e.calibrationVersion && current && e.calibrationVersion !== current;
    lines.push(
      `-# calibration ${e.calibrationVersion ?? 'none'}${stale ? ' (since recalibrated)' : ''}` +
        (e.timesShown > 1 ? ` · shown ${e.timesShown}×` : '')
    );

    embed.addFields({
      name: `${when(e.at)} · ${e.decisive ? 'bench recommendation' : 'too close to call'}`,
      value: lines.join('\n'),
      inline: false
    });
  }

  await interaction.reply({ embeds: [embed] });
}
