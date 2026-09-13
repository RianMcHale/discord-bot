import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { calibrationVersion, calibratedRoles } from '../scoring/calibration.js';
import { BASELINE, HAND_SET_BASELINE } from '../scoring/roles.js';
import { db } from '../storage.js';
import { patchStatus, driftReport } from '../drift.js';

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

  // --- is it still the game the bars were measured on? (spec §7.5) ----------
  const games = db.allGames();
  const patches = patchStatus(games);
  if (patches.calibrated) {
    const cal = patches.calibrated;
    const span = cal.min === cal.max ? cal.max : `${cal.min}–${cal.max}`;
    let value = `Measured on patch${cal.min === cal.max ? '' : 'es'} **${span}**.`;
    if (patches.newest) {
      value +=
        patches.ahead > 0
          ? ` Games are now on **${patches.newest}** — ${patches.ahead} patch${patches.ahead === 1 ? '' : 'es'} past it.`
          : ` Games are on ${patches.newest}, which it covers.`;
    }
    if (patches.crossedBreak) {
      value +=
        `\n⚠️ **${patches.crossedBreak}** is a declared meta break the calibration predates. ` +
        `${patches.staleGames} game${patches.staleGames === 1 ? '' : 's'} past it cannot bench anyone until it is rebuilt.`;
    } else if (patches.ahead >= 3) {
      // Not a hard stop — only declared breaks are — but three patches of
      // balance changes is enough to be worth re-measuring.
      value += '\n-# No declared meta break has been crossed, but it is worth rebuilding after this many patches.';
    }
    if (patches.gamesWithoutPatch > 0) {
      value += `\n-# ${patches.gamesWithoutPatch} older game${patches.gamesWithoutPatch === 1 ? ' has' : 's have'} no patch recorded — \`/rescore\` fills it in.`;
    }
    embed.addFields({ name: 'Patches', value, inline: false });
  }

  // --- has any role drifted away from the others? ----------------------------
  const drift = driftReport(games, { days: 30 });
  const signed = (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
  let driftValue;
  if (drift.centre === null) {
    driftValue =
      `Not enough games in the last ${drift.days} days to check yet — it needs about **${drift.gamesNeeded}** per role ` +
      `to see a 3-point drift through the noise, and there ${drift.games === 1 ? 'is 1' : `are ${drift.games}`}.`;
  } else {
    const line = (r) => {
      const who = `${ROLE_EMOJI[r.role]} ${LABEL[r.role]}`;
      if (r.verdict === 'thin') return `${who} — ${r.n} scores, too few to tell`;
      if (r.verdict === 'drifted') return `${who} ⚠️ **${signed(r.drift)}** against the others · ${r.n} scores`;
      if (r.verdict === 'in-step') return `${who} ✓ in step · within ${r.bound.toFixed(1)} · ${r.n} scores`;
      // Not drifted, but not ruled out either — say how far off it could be,
      // rather than a tick that reads as a clean bill of health.
      return `${who} ${signed(r.drift)} · no clear drift, but could be up to ${r.bound.toFixed(1)} off · ${r.n} scores`;
    };
    const unclear = drift.roles.filter((r) => r.verdict === 'unclear').length;
    driftValue =
      drift.roles.map(line).join('\n') +
      (drift.drifted.length
        ? `\n⚠️ **${drift.drifted.map((r) => LABEL[r.role]).join(', ')}** ` +
          `${drift.drifted.length === 1 ? 'is' : 'are'} scoring away from the other roles — the bar may have moved with a patch. ` +
          'Rebuild the calibration before trusting a bench call that involves that role.'
        : unclear
          ? `\n-# Nothing has clearly drifted. More games will narrow the ranges enough to confirm it.`
          : '\n-# Every role is confirmed in step with the others.');
  }
  embed.addFields({ name: `Drift · last ${drift.days} days of opponents' scores`, value: driftValue, inline: false });

  embed.setFooter({
    text:
      'A bar is the median for that role. 50 means you matched it. Scores carry the version that produced them.\n' +
      'Drift compares each role with the others, not with 50 — a strong squad scores above 50 everywhere without anything being wrong.'
  });

  await interaction.reply({ embeds: [embed] });
}
