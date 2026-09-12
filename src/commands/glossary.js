import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import {
  COMPONENTS,
  METRICS,
  RUBRICS,
  NOT_MEASURED,
  lookup,
  barsFor,
  usedBy,
  explainableIds
} from '../scoring/glossary.js';
import { calibrationVersion, calibratedRoles } from '../scoring/calibration.js';

const ROLE_ICON = { TOP: '⚔️', JUNGLE: '🌲', MIDDLE: '⚡', BOTTOM: '🏹', UTILITY: '🛡️' };

export const data = new SlashCommandBuilder()
  .setName('glossary')
  .setDescription('What a part of the score means, what it is measured against, and where it comes from.')
  .addStringOption((opt) =>
    opt
      .setName('term')
      .setDescription('A component (lane, combat, deaths…) or a metric (dmgShare, killPerDamageShare…)')
      .setAutocomplete(true)
      .setRequired(false)
  );

export async function autocomplete(interaction) {
  const typed = (interaction.options.getFocused() || '').toLowerCase();
  const all = explainableIds();
  const label = (id) => (COMPONENTS[id] ? `${id} — ${COMPONENTS[id].label}` : `${id} — ${METRICS[id].label}`);
  const hits = all.filter((id) => id.toLowerCase().includes(typed) || label(id).toLowerCase().includes(typed));
  await interaction.respond(hits.slice(0, 25).map((id) => ({ name: label(id).slice(0, 100), value: id })));
}

/** The index, when nothing was asked for in particular. */
function indexEmbed() {
  const fmtRubric = (role) =>
    `${ROLE_ICON[role]} **${role}** — ` +
    Object.entries(RUBRICS[role])
      .sort((a, b) => b[1] - a[1])
      .map(([k, w]) => `${COMPONENTS[k]?.label ?? k} ${w}`)
      .join(' · ');

  return new EmbedBuilder()
    .setTitle('How the score is built')
    .setColor(0x1b6b5a)
    .setDescription(
      'Every score is a weighted average of components, each anchored so that **50 means you did the job your role is supposed to do**. ' +
        'Ask about any of them with `/explain term:<name>`.'
    )
    .addFields(
      {
        name: 'Weights by role, at a 27-minute game',
        value: ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'].map(fmtRubric).join('\n'),
        inline: false
      },
      {
        name: 'Components',
        value: Object.entries(COMPONENTS)
          .map(([k, c]) => `\`${k}\` ${c.label}`)
          .join(' · '),
        inline: false
      },
      {
        name: 'Metrics',
        value: Object.keys(METRICS)
          .map((k) => `\`${k}\``)
          .join(' · '),
        inline: false
      },
      {
        name: 'Not measured',
        value: NOT_MEASURED.map((n) => `-# ${n}`).join('\n'),
        inline: false
      }
    )
    .setFooter({
      text:
        'Laning components are weighted by how long the game ran, so these drift either side of the numbers above.\n' +
        'The weights are the same for everyone in a role. If one looks wrong, that is worth arguing about.'
    });
}

function componentEmbed(entry) {
  const weights = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']
    .filter((r) => RUBRICS[r][entry.id] != null)
    .map((r) => `${ROLE_ICON[r]} ${r} **${RUBRICS[r][entry.id]}**`)
    .join(' · ');

  const embed = new EmbedBuilder()
    .setTitle(`${entry.label}`)
    .setColor(0x1b6b5a)
    .setDescription(entry.what)
    .addFields({ name: 'How it is graded', value: entry.how, inline: false });

  if (weights) embed.addFields({ name: 'Weight in each role', value: weights, inline: false });
  if (entry.watch) embed.addFields({ name: 'Worth knowing', value: entry.watch, inline: false });
  if (entry.metrics?.length) {
    embed.addFields({
      name: 'Built from',
      value: entry.metrics.map((m) => `\`${m}\` ${METRICS[m]?.label ?? ''}`).join('\n'),
      inline: false
    });
  }
  return embed.setFooter({ text: `Component · \`/explain term:${entry.id}\`` });
}

function metricEmbed(entry) {
  const embed = new EmbedBuilder()
    .setTitle(entry.label)
    .setColor(0x1b6b5a)
    .setDescription(entry.what)
    .addFields({
      name: 'Source and confidence',
      value: `${entry.source} · **${entry.confidence}** confidence`,
      inline: false
    });

  // The live bar, read out of the calibration rather than written down — so what
  // this prints is what the model actually graded the last game against.
  const bars = barsFor(entry);
  if (bars) {
    embed.addFields({
      name: 'What par is, per role',
      value:
        bars
          .map((b) => `${ROLE_ICON[b.role]} ${b.role} **${round(b.value)}**${b.measured ? '' : ' *(estimate)*'}`)
          .join(' · ') + '\n-# 50 on the scorecard means you hit this number.',
      inline: false
    });
  }

  const uses = usedBy(entry.id);
  if (uses.length) {
    embed.addFields({
      name: 'Used by',
      value: uses
        .map((u) => `**${u.label}** — ${u.weights.map((w) => `${ROLE_ICON[w.role]} ${w.weight}`).join(' · ')}`)
        .join('\n'),
      inline: false
    });
  }

  if (entry.note) embed.addFields({ name: 'Why it is in the model', value: entry.note, inline: false });

  const version = calibrationVersion();
  return embed.setFooter({
    text: `Metric · bars from calibration ${version ?? 'none (running on estimates)'} · ${calibratedRoles().length}/5 roles measured`
  });
}

const round = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 1000) / 1000);

export async function execute(interaction) {
  const term = interaction.options.getString('term');

  if (!term) {
    await interaction.reply({ embeds: [indexEmbed()] });
    return;
  }

  const entry = lookup(term);
  if (!entry) {
    const closest = explainableIds()
      .filter((id) => id.toLowerCase().includes(term.toLowerCase().slice(0, 4)))
      .slice(0, 6);
    await interaction.reply(
      `No part of the score is called **${term}**.` +
        (closest.length ? `\nDid you mean: ${closest.map((c) => `\`${c}\``).join(' · ')}` : '') +
        '\n-# `/explain` with no term lists everything.'
    );
    return;
  }

  await interaction.reply({
    embeds: [entry.kind === 'component' ? componentEmbed(entry) : metricEmbed(entry)]
  });
}
