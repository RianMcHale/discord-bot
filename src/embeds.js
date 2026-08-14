// Shared presentation. /fetchgame and the background watcher post identical
// scorecards, so the layout lives here rather than inside either of them.

import { EmbedBuilder } from 'discord.js';

export const ROLE_DISPLAY = {
  TOP: { abbrev: 'TOP', label: 'Top', emoji: '🛡️' },
  JUNGLE: { abbrev: 'JGL', label: 'Jungle', emoji: '🌲' },
  MIDDLE: { abbrev: 'MID', label: 'Mid', emoji: '⚡' },
  BOTTOM: { abbrev: 'ADC', label: 'ADC', emoji: '🏹' },
  UTILITY: { abbrev: 'SUP', label: 'Support', emoji: '💚' }
};

export const ROLE_ORDER = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

export function roleInfo(role) {
  return ROLE_DISPLAY[role] || { abbrev: '?', label: 'Unknown role', emoji: '❓' };
}

export function scoreBar(score) {
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

/** The component that dragged a player's score down most — the bench-relevant one. */
export function weakest(s, n = 1) {
  const scored = s.components.filter((c) => c.score !== null).sort((a, b) => a.score - b.score);
  return scored.slice(0, n);
}

export function componentText(c) {
  return `${c.label} ${Math.round(c.score)}`;
}

/**
 * Posts scorecards one per message.
 *
 * Discord's 6000-character embed budget applies to the *message*, summed across
 * every embed in it — not to each embed. Batching several scorecards into one
 * reply exceeds it and Discord rejects the entire send with
 * MAX_EMBED_SIZE_EXCEEDED, so there is no "safe" batch size worth guessing at.
 */
export async function postScorecards(interaction, embeds) {
  if (embeds.length === 0) return 0;
  await interaction.editReply({ embeds: [embeds[0]] });
  for (const embed of embeds.slice(1)) {
    await interaction.followUp({ embeds: [embed] });
  }
  return embeds.length;
}

/**
 * The per-match scorecard. Exported separately from any command so the layout
 * can be rendered and eyeballed without a live Discord interaction.
 */
export function buildMatchEmbed({ scores, scoresByDiscordId, nameByDiscordId, matchInfo, hasTimeline, detail = false, alsoNew = 0 }) {
  const sorted = Object.entries(scoresByDiscordId).sort((a, b) => b[1].composite - a[1].composite);
  const [worstDiscordId, worst] = sorted[sorted.length - 1];
  const win = sorted[0][1].win;
  const squadTeamId = sorted[0][1].teamId;

  const embed = new EmbedBuilder()
    .setTitle(`${win ? '🏆 Victory' : '💀 Defeat'} · ${Math.round(matchInfo.gameDuration / 60)} min`)
    .setColor(win ? 0x2ecc71 : 0xe74c3c)
    // Persistent hints live in the footer rather than their own field — they're
    // the same every game, and a field per hint is most of what made this cluttered.
    .setFooter({
      text: detail
        ? '50 = did your job for your role · /leaderboard for the rolling average'
        : '50 = did your job for your role · detail:true for the full per-role breakdown'
    });

  if (!hasTimeline) {
    embed.setDescription(
      '-# ⚠️ Timeline unavailable — lane state, gank pressure and death context are missing from these scores.'
    );
  }

  // --- one card per player, best to worst ------------------------------------
  // Inline so Discord packs three per row. Cards sit in a narrow column, so each
  // line has to fit one: score, the KDA and lane result behind it, and the single
  // component that cost them most. The context flags deliberately live in the
  // sections below rather than here — repeating them in both is what made the
  // first version a wall of text, and a card that grows a note is also a card
  // that's taller than the two beside it.
  for (const [discordId, s] of sorted) {
    const info = roleInfo(s.role);
    const gold =
      s.context.goldDiff14 == null ? '' : ` · ${s.context.goldDiff14 >= 0 ? '+' : ''}${s.context.goldDiff14}g @${s.context.benchMinute}`;

    embed.addFields({
      name: `${info.emoji} ${info.label} · ${s.grade}${discordId === worstDiscordId ? ' 🔻' : ''}`,
      value:
        `<@${discordId}> — **${s.champion}**\n` +
        `\`${scoreBar(s.composite)}\` **${s.composite.toFixed(1)}**\n` +
        `KDA ${s.kda}${gold}\n` +
        `-# Weakest: ${weakest(s).map(componentText).join('')}`,
      inline: true
    });
  }

  // --- the bench call, the one player who gets full reasoning ----------------
  const worstRole = roleInfo(worst.role);
  const worstNotes = worst.notes.length ? `\n-# ${worst.notes.join(' · ')}` : '';
  embed.addFields({
    name: '🪑 Bench watch',
    value:
      `<@${worstDiscordId}> — ${worstRole.emoji} **${worstRole.label} ${worst.champion}** · ${worst.composite.toFixed(1)} (${worst.grade})\n` +
      `Weakest: ${weakest(worst, 3).map(componentText).join(' · ')}${worstNotes}\n` +
      `-# One bad game shouldn't outweigh a good rolling average — check \`/leaderboard\` first.`,
    inline: false
  });

  // --- context flags for everyone else, only when there's something to say ---
  const flagged = sorted.filter(([id, s]) => id !== worstDiscordId && s.notes.length > 0);
  if (flagged.length > 0) {
    embed.addFields({
      name: '📌 Worth knowing',
      value: flagged
        .map(([id, s]) => `-# ${roleInfo(s.role).emoji} **${nameByDiscordId[id]}** — ${s.notes.join(' · ')}`)
        .join('\n'),
      inline: false
    });
  }

  // --- full per-player breakdown, opt-in -------------------------------------
  if (detail) {
    for (const [discordId, s] of sorted) {
      const info = roleInfo(s.role);
      embed.addFields({
        name: `${info.emoji} ${info.label} · ${nameByDiscordId[discordId]} · ${s.composite.toFixed(1)} (${s.grade}) · ${s.champion}`,
        value: s.components
          .map((c) => `\`${(c.score === null ? '--' : c.score.toFixed(1)).padStart(5)}\` **${c.label}** *${c.weight}%*${c.detail ? ` · ${c.detail}` : ''}`)
          .join('\n'),
        inline: false
      });
    }
  }

  // Enemy team on one line — enough to tell whether the lobby was one-sided.
  const enemyEntries = Object.values(scores)
    .filter((s) => s.teamId !== squadTeamId)
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));

  if (enemyEntries.length > 0) {
    embed.addFields({
      name: '⚔️ Enemy team',
      value: enemyEntries.map((e) => `${roleInfo(e.role).abbrev} ${e.champion} **${Math.round(e.composite)}**`).join(' · '),
      inline: false
    });
  }

  if (alsoNew > 0) {
    embed.addFields({
      name: '​',
      value: `-# ${alsoNew} more new shared ${alsoNew === 1 ? 'match' : 'matches'} still queued — run \`/fetchgame\` again.`,
      inline: false
    });
  }

  return { embed, worstDiscordId };
}
