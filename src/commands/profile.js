import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { db } from '../storage.js';
import { computeCareerStats } from '../rollingStats.js';
import { roleInfo, scoreBar, ROLE_ORDER } from '../embeds.js';

const fmt = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');

// A champion needs a couple of games before its average means anything, and the
// spread between best and worst needs to be wide enough not to be sample noise.
const MIN_CHAMPION_GAMES = 2;
const MEANINGFUL_GAP = 10;

// Coarse blocks give a readable shape from a handful of games without pretending
// to more precision than a 0-100 score has.
const SPARK = '▁▂▃▄▅▆▇█';
function sparkline(scores) {
  return scores.map((s) => SPARK[Math.max(0, Math.min(7, Math.floor(s / 12.5)))]).join('');
}

function formLine(s) {
  if (s.formDelta === null) return 'not enough games to judge form yet';
  if (s.formDelta >= 1.5) return `▲ **${fmt(s.form)}** over the last 5 — ${fmt(s.formDelta)} above their average`;
  if (s.formDelta <= -1.5) return `▼ **${fmt(s.form)}** over the last 5 — ${fmt(Math.abs(s.formDelta))} below their average`;
  return `▬ **${fmt(s.form)}** over the last 5 — steady`;
}

export const data = new SlashCommandBuilder()
  .setName('profile')
  .setDescription("One player's full record: per-role averages, form, best and worst games.")
  .addUserOption((opt) => opt.setName('player').setDescription('Whose profile to show (default: you)').setRequired(false));

export async function execute(interaction) {
  const targetUser = interaction.options.getUser('player') || interaction.user;

  const player = db.getPlayer(targetUser.id);
  if (!player) {
    await interaction.reply({ content: `<@${targetUser.id}> hasn't run \`/register\` yet.`, ephemeral: true });
    return;
  }

  const { stats } = computeCareerStats();
  const s = stats.find((x) => x.discordId === targetUser.id);
  if (!s) {
    await interaction.reply(`No scored games yet for <@${targetUser.id}>.`);
    return;
  }

  const rank = stats.findIndex((x) => x.discordId === targetUser.id) + 1;

  const embed = new EmbedBuilder()
    .setTitle(`${player.riotGameName}#${player.riotTagLine}`)
    .setColor(0x5865f2)
    .setThumbnail(targetUser.displayAvatarURL?.() ?? null)
    .setDescription(
      `<@${targetUser.id}> — \`${scoreBar(s.average)}\` **${fmt(s.average)}** overall · ` +
        `**#${rank}** of ${stats.length}\n` +
        `-# ${s.gamesPlayed} games · ${s.wins}W ${s.losses}L (${s.winRate}%) · benched ${s.benched}×`
    )
    .setFooter({ text: '50 = did your job for your role · /alltime for the squad standings' });

  // Per-role is the heart of this command: the scores are role-anchored, so a
  // player's Mid average and their Jungle average mean the same thing and can be
  // compared directly. That comparison is the whole argument for who plays what.
  // Lane order rather than most-played: this reads as a vertical list, so the
  // order people already have in their heads beats sorting by sample size.
  const rolesInLaneOrder = [...s.byRole].sort(
    (a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
  );

  embed.addFields({
    name: '📊 By role',
    value: rolesInLaneOrder
      .map((r) => {
        const info = roleInfo(r.role);
        return `${info.emoji} **${info.label}** \`${scoreBar(r.average)}\` ${fmt(r.average)} · ${r.games} game${r.games === 1 ? '' : 's'}`;
      })
      .join('\n'),
    inline: false
  });

  embed.addFields({ name: '📈 Form', value: formLine(s), inline: false });

  const recent = s.history.slice(0, 12).reverse(); // oldest to newest, reads left to right
  if (recent.length >= 3) {
    embed.addFields({
      name: `🕒 Last ${recent.length} games`,
      value:
        `\`${sparkline(recent.map((h) => h.score))}\`\n` +
        `-# ${recent.map((h) => Math.round(h.score)).join(' · ')}`,
      inline: false
    });
  }

  const best = s.bestGame;
  const worst = s.worstGame;
  embed.addFields(
    {
      name: '🥇 Best game',
      value: `${roleInfo(best.role).emoji} **${fmt(best.score)}** · ${best.win ? 'W' : 'L'} · <t:${Math.floor(best.playedAt / 1000)}:d>`,
      inline: true
    },
    {
      name: '💀 Worst game',
      value: `${roleInfo(worst.role).emoji} **${fmt(worst.score)}** · ${worst.win ? 'W' : 'L'} · <t:${Math.floor(worst.playedAt / 1000)}:d>`,
      inline: true
    }
  );

  // Only worth showing once a champion has been played enough to mean anything.
  const champs = s.byChampion.filter((c) => c.games >= MIN_CHAMPION_GAMES);
  if (champs.length > 0) {
    const ranked = [...champs].sort((a, b) => b.average - a.average);
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    const gap = best.average - worst.average;
    // A verdict only when the spread is big enough to be a real signal rather
    // than the noise you'd get from any two small samples.
    const verdict =
      ranked.length >= 2 && gap >= MEANINGFUL_GAP
        ? `\n-# **${worst.champion}** is ${fmt(gap)} below **${best.champion}** — worth dropping from the pool.`
        : '';

    embed.addFields({
      name: '🎭 Champions',
      value:
        champs
          .slice(0, 6)
          .map((c) => {
            const mark = ranked.length >= 2 && gap >= MEANINGFUL_GAP && c.champion === best.champion
              ? '🟢'
              : ranked.length >= 2 && gap >= MEANINGFUL_GAP && c.champion === worst.champion
                ? '🔴'
                : '▫️';
            return `${mark} **${c.champion}** ${fmt(c.average)} · ${c.games} games · ${Math.round((c.wins / c.games) * 100)}% W`;
          })
          .join('\n') + verdict,
      inline: false
    });
  }

  await interaction.reply({ embeds: [embed] });
}
