import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { db } from '../storage.js';
import { explainPerformance, distinctNotes } from '../explainScore.js';
import { ROLE_NAME } from '../narrate.js';

export const data = new SlashCommandBuilder()
  .setName('explain')
  .setDescription('Why someone scored what they did in a game — good or bad.')
  .addUserOption((opt) => opt.setName('player').setDescription('Whose score (defaults to you)').setRequired(false))
  .addStringOption((opt) =>
    opt
      .setName('game')
      .setDescription('Which game (defaults to their most recent)')
      .setAutocomplete(true)
      .setRequired(false)
  );

/** Recent games, newest first, labelled well enough to pick from a dropdown. */
export async function autocomplete(interaction) {
  const typed = (interaction.options.getFocused() || '').toLowerCase();
  const names = Object.fromEntries(db.allPlayers().map((p) => [p.discordId, p.riotGameName]));

  const choices = db
    .allGames()
    .reverse()
    .map((g) => {
      const entries = Object.entries(g.scores);
      const win = entries[0]?.[1]?.win;
      const date = new Date(g.playedAt).toLocaleDateString();
      const who = entries.map(([id, s]) => `${names[id] ?? '?'} ${s.champion}`).join(', ');
      return {
        name: `${win ? 'W' : 'L'} · ${date} · ${Math.round((g.durationSeconds ?? 0) / 60)}min · ${who}`.slice(0, 100),
        value: g.matchId
      };
    })
    .filter((c) => !typed || c.name.toLowerCase().includes(typed))
    .slice(0, 25);

  await interaction.respond(choices);
}

const signed = (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1));
const titleCase = (s) => s.replace(/^./, (x) => x.toUpperCase());

export async function execute(interaction) {
  const target = interaction.options.getUser('player') ?? interaction.user;
  const requested = interaction.options.getString('game');

  const player = db.allPlayers().find((p) => p.discordId === target.id);
  if (!player) {
    await interaction.reply({ content: `<@${target.id}> isn't registered — \`/register\` them first.`, ephemeral: true });
    return;
  }

  // Their own most recent scored game, not the squad's.
  const theirs = db.allGames().filter((g) => g.scores?.[target.id]);
  const game = requested ? theirs.find((g) => g.matchId === requested) : theirs[theirs.length - 1];

  if (!game) {
    await interaction.reply({
      content: requested
        ? `<@${target.id}> doesn't have a score stored for \`${requested}\`. They may not have played it.`
        : `No scored games for <@${target.id}> yet — run \`/fetchgame\` after your next match.`,
      ephemeral: true
    });
    return;
  }

  const scored = game.scores[target.id];
  const e = explainPerformance(scored);
  const roleName = ROLE_NAME[scored.role] ?? 'player';
  const minutes = Math.round((game.durationSeconds ?? 0) / 60);

  const embed = new EmbedBuilder()
    .setTitle(`${player.riotGameName} — ${scored.champion}, ${roleName}`)
    .setColor(e.fromPar >= 8 ? 0x2f7d5c : e.fromPar <= -8 ? 0xa8423f : 0x7c8a86)
    .setDescription(
      `**${scored.composite}** · ${scored.grade} · ${scored.win ? 'Win' : 'Loss'} · ${minutes} min · ${scored.kda}\n\n` +
        `${e.summary}`
    );

  // One short paragraph per thing that actually moved the score, in the order
  // it mattered. The heading carries the component's own score and what it did
  // to the final number, so the paragraph underneath can be plain sentences.
  const paragraphs = [];
  for (const r of e.reasons) {
    const body = [r.why, r.fix].filter(Boolean).join(' ');
    paragraphs.push(body);
    embed.addFields({
      name: `${r.label} · ${Math.round(r.score)}  (${signed(r.contribution)})`,
      value: body || '-# No detail stored for this game.',
      inline: false
    });
  }

  if (e.remainder) embed.addFields({ name: '​', value: `-# ${e.remainder}`, inline: false });

  // Anything the model flagged that the paragraphs have not already told.
  const extra = distinctNotes(scored.notes, e.reasons);
  if (extra.length) {
    embed.addFields({ name: '​', value: extra.map((n) => `-# ${titleCase(n)}`).join('\n'), inline: false });
  }

  const stale = e.reasons.some((r) => !r.fromFacts);
  embed.setFooter({
    text:
      '50 is par for the role · figures in brackets are points of the final score' +
      (stale ? '\nScored before fuller detail was kept — /rescore refreshes it' : '')
  });

  await interaction.reply({ embeds: [embed] });
}
