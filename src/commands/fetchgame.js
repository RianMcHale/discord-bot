import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { riot } from '../riotApi.js';
import { db } from '../storage.js';
import { scoreMatch } from '../scoring/index.js';

const ROLE_DISPLAY = {
  TOP: { abbrev: 'TOP', label: 'Top', emoji: '🛡️' },
  JUNGLE: { abbrev: 'JGL', label: 'Jungle', emoji: '🌲' },
  MIDDLE: { abbrev: 'MID', label: 'Mid', emoji: '⚡' },
  BOTTOM: { abbrev: 'ADC', label: 'ADC', emoji: '🏹' },
  UTILITY: { abbrev: 'SUP', label: 'Support', emoji: '💚' }
};

const ROLE_ORDER = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

function roleInfo(role) {
  return ROLE_DISPLAY[role] || { abbrev: '?', label: 'Unknown role', emoji: '❓' };
}

// The scoreboard is a fixed-width table inside a code block, which is the only
// way Discord will align anything. One column spec drives both the header and
// the rows so they can't drift apart.
const COLS = [
  { key: 'rank', head: '#', width: 2 },
  { key: 'role', head: 'ROLE', width: 4 },
  { key: 'name', head: 'PLAYER', width: 13 },
  { key: 'score', head: 'SCORE', width: 6, align: 'right' },
  { key: 'kda', head: 'KDA', width: 8 },
  { key: 'weak', head: 'WEAKEST', width: 16 }
];

function tableRow(values) {
  return COLS.map((c) => {
    const v = String(values[c.key] ?? '').slice(0, c.width);
    return c.align === 'right' ? v.padStart(c.width) : v.padEnd(c.width);
  })
    .join(' ')
    .trimEnd();
}

/** The component that dragged a player's score down most — the bench-relevant one. */
function weakest(s, n = 1) {
  const scored = s.components.filter((c) => c.score !== null).sort((a, b) => a.score - b.score);
  return scored.slice(0, n);
}

function componentText(c) {
  return `${c.label} ${Math.round(c.score)}`;
}

// Pull recent match ids from EVERY registered player, not just one "anchor" —
// otherwise a game gets missed entirely whenever that one anchor player is the
// one sitting out the rotation for that match.
async function fetchAllCandidateMatchIds(players, lookback) {
  const idSet = new Set();
  for (const player of players) {
    try {
      const ids = await riot.getRecentMatchIds(player.puuid, lookback);
      ids.forEach((id) => idSet.add(id));
    } catch (err) {
      console.error(`Failed to fetch match history for ${player.riotGameName}#${player.riotTagLine}:`, err.message);
    }
  }
  return [...idSet];
}

/**
 * Builds the result embed. Exported separately from `execute` so the layout can
 * be rendered and eyeballed without a live Discord interaction.
 */
export function buildMatchEmbed({ scores, scoresByDiscordId, nameByDiscordId, matchInfo, hasTimeline, detail, alsoNew }) {
  const sorted = Object.entries(scoresByDiscordId).sort((a, b) => b[1].composite - a[1].composite);
  const [worstDiscordId, worst] = sorted[sorted.length - 1];
  const win = sorted[0][1].win;
  const squadTeamId = sorted[0][1].teamId;

  // --- scoreboard -----------------------------------------------------------
  const rows = sorted.map(([discordId, s], i) =>
    tableRow({
      rank: i + 1,
      role: roleInfo(s.role).abbrev,
      name: nameByDiscordId[discordId],
      score: `${Math.round(s.composite)} ${s.grade}`,
      kda: s.kda,
      weak: weakest(s).map(componentText).join('')
    })
  );
  const header = tableRow(Object.fromEntries(COLS.map((c) => [c.key, c.head])));
  const board = ['```', header, ...rows, '```'].join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`${win ? '🏆 Victory' : '💀 Defeat'} · ${Math.round(matchInfo.gameDuration / 60)} min`)
    .setColor(win ? 0x2ecc71 : 0xe74c3c)
    .setDescription(
      board +
        (hasTimeline
          ? ''
          : '\n-# ⚠️ Timeline unavailable — lane state, gank pressure and death context are missing from these scores.')
    )
    // Persistent hints live in the footer rather than their own field — they're
    // the same every game, and a field per hint is most of what made this cluttered.
    .setFooter({
      text: detail
        ? '50 = did your job for your role · /vote to add impact ratings'
        : '50 = did your job for your role · /vote to add impact ratings · detail:true for the full breakdown'
    });

  // --- the bench call, the one thing that gets full detail -------------------
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

  // --- context flags, only for players who actually have one -----------------
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
      value: `-# ${alsoNew} more new shared ${alsoNew === 1 ? 'match' : 'matches'} found — run \`/fetchgame\` again to score the next one.`,
      inline: false
    });
  }

  return { embed, worstDiscordId };
}

export const data = new SlashCommandBuilder()
  .setName('fetchgame')
  .setDescription('Pull the most recent match your registered squad played together and score it.')
  .addIntegerOption((opt) =>
    opt.setName('lookback').setDescription('How many recent matches per player to search through (default 5)').setRequired(false)
  )
  .addBooleanOption((opt) =>
    opt.setName('detail').setDescription("Show every player's full per-role breakdown instead of the summary").setRequired(false)
  );

export async function execute(interaction) {
  await interaction.deferReply();

  const players = db.allPlayers();
  if (players.length < 2) {
    await interaction.editReply('Need at least 2 players registered with `/register` before I can score anything.');
    return;
  }

  const lookback = interaction.options.getInteger('lookback') || 5;
  const detail = interaction.options.getBoolean('detail') || false;
  const trackedPuuids = players.map((p) => p.puuid);

  try {
    const candidateIds = await fetchAllCandidateMatchIds(players, lookback);

    const skipped = [];
    const qualifying = []; // { matchId, match, timestamp }

    for (const matchId of candidateIds) {
      if (db.hasGame(matchId)) {
        skipped.push({ matchId, reason: 'already scored' });
        continue;
      }
      const match = await riot.getMatch(matchId);
      const participantsPuuids = match.info.participants.map((p) => p.puuid);
      const overlap = trackedPuuids.filter((puuid) => participantsPuuids.includes(puuid));
      if (overlap.length >= 2) {
        qualifying.push({
          matchId,
          match,
          timestamp: match.info.gameEndTimestamp || match.info.gameStartTimestamp || 0
        });
      } else {
        skipped.push({ matchId, reason: `only ${overlap.length} registered player(s) played` });
      }
    }

    if (qualifying.length === 0) {
      const skippedList = skipped.length
        ? '\n\nChecked and skipped:\n' + skipped.map((s) => `\`${s.matchId}\` — ${s.reason}`).join('\n')
        : '';
      await interaction.editReply(
        `No new shared matches found across the squad's last ${lookback} games each. Try increasing \`lookback\`.${skippedList}`
      );
      return;
    }

    // Most recent qualifying match wins, regardless of whose match list it came from.
    qualifying.sort((a, b) => b.timestamp - a.timestamp);
    const { matchId: chosenId, match: chosenMatch } = qualifying[0];
    const alsoNew = qualifying.length - 1;

    // Only the match we're actually scoring needs the (heavier) timeline call.
    const timeline = await riot.getTimeline(chosenId);

    // scores includes BOTH teams — every player in the lobby, scored against the
    // rubric for the role they played.
    const scores = scoreMatch(chosenMatch, { timeline, trackedPuuids });

    const byPuuid = Object.fromEntries(players.map((p) => [p.puuid, p]));
    const scoresByDiscordId = {};
    const nameByDiscordId = {};
    for (const [puuid, s] of Object.entries(scores)) {
      const player = byPuuid[puuid];
      if (!player) continue;
      scoresByDiscordId[player.discordId] = s;
      nameByDiscordId[player.discordId] = player.riotGameName;
    }

    // Store only the tracked squad's scores — that's all rolling averages need.
    db.saveGame(chosenId, {
      matchId: chosenId,
      playedAt: chosenMatch.info.gameEndTimestamp || chosenMatch.info.gameStartTimestamp || Date.now(),
      queueId: chosenMatch.info.queueId,
      durationSeconds: chosenMatch.info.gameDuration,
      dataQuality: timeline ? 'full' : 'partial',
      scores: scoresByDiscordId
    });

    const { embed } = buildMatchEmbed({
      scores,
      scoresByDiscordId,
      nameByDiscordId,
      matchInfo: chosenMatch.info,
      hasTimeline: Boolean(timeline),
      detail,
      alsoNew
    });

    await interaction.editReply({ embeds: [embed] });
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
