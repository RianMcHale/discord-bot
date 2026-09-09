import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { calibrationVersion, calibratedRoles } from '../scoring/calibration.js';
import { BASELINE, HAND_SET_BASELINE } from '../scoring/roles.js';

const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const ROLE_EMOJI = { TOP: '🛡️', JUNGLE: '🌲', MIDDLE: '⚡', BOTTOM: '🏹', UTILITY: '💚' };
const LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Support' };

// The bars a player is actually measured against, in the order they matter.
const SHOWN = [
  ['dmgShare', 'damage share', (v) => `${(v * 100).toFixed(1)}%`],
  ['killShare', 'kill share', (v) => `${(v * 100).toFixed(1)}%`],
  ['epicShare', 'objective share', (v) => `${(v * 100).toFixed(0)}%`],
  ['csPerMin', 'cs/min', (v) => v.toFixed(1)],
  ['visionPerMin', 'vision/min', (v) => v.toFixed(2)]
];

export const data = new SlashCommandBuilder()
  .setName('calibration')
  .setDescription('What the scores are measured against, and how much of it is measured rather than guessed.');

export async function execute(interaction) {
  const version = calibrationVersion();
  const calibrated = calibratedRoles();

  const embed = new EmbedBuilder()
    .setTitle('📐 Calibration')
    .setColor(calibrated.length === 5 ? 0x2ecc71 : 0xe67e22);

  if (!version) {
    embed.setDescription(
      'Running on **hand-set baselines** — every bar is an estimate, not a measurement.\n' +
        '-# Collect a sample with `npm run calibration-pull`, then `npm run build-calibration`.'
    );
    await interaction.reply({ embeds: [embed] });
    return;
  }

  const missing = ROLES.filter((r) => !calibrated.includes(r));
  embed.setDescription(
    `Version \`${version}\` · **${calibrated.length}/5** roles on measured baselines.` +
      (missing.length
        ? `\n-# ${missing.map((r) => LABEL[r]).join(', ')} still on estimates — their sample is too thin to trust, ` +
          'so the hand-set number stands rather than being replaced by a noisy one.'
        : '\n-# Every role is measured against the median of a real sample.')
  );

  // Show what actually changed. A calibration that moved nothing is worth
  // knowing about too.
  for (const role of ROLES) {
    const now = BASELINE[role];
    const hand = HAND_SET_BASELINE[role];
    const lines = [];
    for (const [key, label, fmt] of SHOWN) {
      if (now[key] == null || hand[key] == null) continue;
      const moved = Math.abs(now[key] - hand[key]) / hand[key] > 0.02;
      lines.push(
        `-# ${label}: ${fmt(now[key])}` +
          (moved ? ` *(was ${fmt(hand[key])}, a guess)*` : '')
      );
    }
    embed.addFields({
      name: `${ROLE_EMOJI[role]} ${LABEL[role]}${calibrated.includes(role) ? '' : ' — estimated'}`,
      value: lines.join('\n') || '-# no bars to show',
      inline: true
    });
  }

  embed.setFooter({
    text: 'A bar is the median for that role. 50 means you matched it. Scores carry the version that produced them.'
  });

  await interaction.reply({ embeds: [embed] });
}
