import { SlashCommandBuilder } from 'discord.js';
import { db } from '../storage.js';
import { buildMatchEmbed, roleInfo } from '../embeds.js';

/**
 * Re-opens a game that was already scored.
 *
 * Everything needed is in the database — the full per-role component breakdown
 * is stored with each game, not just the composite — so this costs no Riot API
 * calls and works on any game in your history, however old.
 */
export const data = new SlashCommandBuilder()
  .setName('match')
  .setDescription('Re-open a scored game, with the full per-role breakdown.')
  .addStringOption((opt) =>
    opt
      .setName('game')
      .setDescription('Which game (defaults to the most recent)')
      .setAutocomplete(true)
      .setRequired(false)
  )
  .addBooleanOption((opt) =>
    opt.setName('summary').setDescription('Show the short scorecard instead of the full breakdown').setRequired(false)
  );

/** Recent games, newest first, labelled well enough to pick from a dropdown. */
export async function autocomplete(interaction) {
  const typed = (interaction.options.getFocused() || '').toLowerCase();
  const players = Object.fromEntries(db.allPlayers().map((p) => [p.discordId, p.riotGameName]));

  const choices = db
    .allGames()
    .reverse()
    .map((g) => {
      const entries = Object.entries(g.scores);
      const win = entries[0]?.[1]?.win;
      const date = new Date(g.playedAt).toLocaleDateString();
      const who = entries
        .map(([id, s]) => `${players[id] ?? '?'} ${s.champion}`)
        .join(', ');
      return {
        name: `${win ? 'W' : 'L'} · ${date} · ${Math.round((g.durationSeconds ?? 0) / 60)}min · ${who}`.slice(0, 100),
        value: g.matchId
      };
    })
    .filter((c) => !typed || c.name.toLowerCase().includes(typed))
    .slice(0, 25); // Discord's limit

  await interaction.respond(choices);
}

export async function execute(interaction) {
  const requested = interaction.options.getString('game');
  const summary = interaction.options.getBoolean('summary') || false;

  const games = db.allGames();
  if (games.length === 0) {
    await interaction.reply('No scored games yet — run `/fetchgame` after your next match.');
    return;
  }

  const game = requested ? db.getGame(requested) : games[games.length - 1];
  if (!game) {
    await interaction.reply({ content: `No stored game with id \`${requested}\`.`, ephemeral: true });
    return;
  }

  const nameByDiscordId = Object.fromEntries(db.allPlayers().map((p) => [p.discordId, p.riotGameName]));

  const { embed } = buildMatchEmbed({
    scoresByDiscordId: game.scores,
    nameByDiscordId,
    durationSeconds: game.durationSeconds ?? 0,
    hasTimeline: game.dataQuality !== 'partial',
    // Games scored before the enemy line was stored simply omit that section.
    enemy: game.enemy ?? [],
    detail: !summary,
    playedAt: game.playedAt
  });

  embed.setFooter({ text: `Match ${game.matchId} · 50 = did your job for your role` });

  // A one-line summary of who played what, so the reply is useful even collapsed.
  const roster = Object.entries(game.scores)
    .sort((a, b) => b[1].composite - a[1].composite)
    .map(([id, s]) => `${roleInfo(s.role).emoji} ${nameByDiscordId[id] ?? 'unknown'}`)
    .join(' · ');

  await interaction.reply({ content: `-# ${roster}`, embeds: [embed] });
}
