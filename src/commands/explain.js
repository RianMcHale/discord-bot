import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { db } from '../storage.js';
import { explainPerformance, distinctNotes } from '../explainScore.js';
import { NOT_MEASURED } from '../scoring/glossary.js';

const ROLE_ICON = { TOP: '⚔️', JUNGLE: '🌲', MIDDLE: '⚡', BOTTOM: '🏹', UTILITY: '🛡️', UNKNOWN: '❔' };

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

export async function execute(interaction) {
  const target = interaction.options.getUser('player') ?? interaction.user;
  const requested = interaction.options.getString('game');

  const player = db.allPlayers().find((p) => p.discordId === target.id);
  if (!player) {
    await interaction.reply({
      content: `<@${target.id}> isn't registered — \`/register\` them first.`,
      ephemeral: true
    });
    return;
  }

  // Their own most recent scored game, not the squad's: someone who sat out the
  // last two should still get an explanation of the last one they played.
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
  const icon = ROLE_ICON[scored.role] ?? ROLE_ICON.UNKNOWN;

  const embed = new EmbedBuilder()
    .setTitle(`${icon} ${player.riotGameName} — ${scored.champion}, ${(scored.role ?? '').toLowerCase()}`)
    .setColor(e.fromPar >= 10 ? 0x2f7d5c : e.fromPar <= -10 ? 0xa8423f : 0x95a5a6)
    .setDescription(
      `**${scored.composite}** (${scored.grade}) · ${scored.win ? 'Won' : 'Lost'} · ` +
        `${Math.round((game.durationSeconds ?? 0) / 60)} min · ${scored.kda}\n\n` +
        `${e.headline}\n-# ${e.par}`
    );

  for (const s of e.sections) embed.addFields({ name: s.name, value: s.value, inline: false });
  if (e.closing) embed.addFields({ name: '​', value: `-# ${e.closing}`, inline: false });

  // Things the model noticed that are not components — camped, comeback, steals.
  // Filtered against what the reasons already said, so a figure is not repeated
  // in different words two lines below itself.
  const extra = distinctNotes(scored.notes, e.sections);
  if (extra.length) {
    embed.addFields({ name: 'Also', value: extra.map((n) => `-# ${n}`).join('\n'), inline: false });
  }

  // The same disclosure /worst carries. An explanation that does not say what it
  // could not see is overclaiming, and this command is read more closely than
  // most.
  embed.setFooter({
    text:
      `Each figure is how many points of the ${scored.composite} that part is responsible for — they sum to the distance from 50.\n` +
      `Not measured: ${NOT_MEASURED.join(' · ')}. /glossary explains any component.`
  });

  await interaction.reply({ embeds: [embed] });
}
