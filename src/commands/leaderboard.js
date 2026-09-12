import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { computeBenchRatings } from '../benchRating.js';
import { config } from '../config.js';

// One rating, shown in two places.
//
// This used to rank on a raw mean while /worst ranked on a shrunk, recency-
// weighted rating with an interval. The two disagreed, and disagreed in the
// direction that matters: on eight games the leaderboard showed one player 8.5
// points below another and /worst called the same pair indistinguishable. A
// third player appeared here and was missing there entirely, because four games
// is not four *effective* games once they are a week old.
//
// That is finding F6 arriving through a side door. The leaderboard is the
// casually-read one, so the wrong number was the one people saw most.
export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription(`Recent form: each player's rating over their own last ${config.rollingWindow} games.`);

const fmtRange = (p) => `${p.rating} \`[${p.low} – ${p.high}]\``;

export async function execute(interaction) {
  const { ranked, provisional, shrinkage, excluded, minEffectiveGames } = computeBenchRatings({
    window: config.rollingWindow
  });

  if (ranked.length === 0 && provisional.length === 0) {
    await interaction.reply(
      excluded > 0
        ? `${excluded} stored game${excluded === 1 ? ' was' : 's were'} set aside as not sound enough to rank on — ` +
            'scored without a timeline, an uncertain role, or a game somebody left.'
        : 'No scored games yet — run `/fetchgame` after your next match.'
    );
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`Recent form (last ${config.rollingWindow} games)`)
    .setColor(0x3498db);

  if (ranked.length > 0) {
    const best = [...ranked].sort((a, b) => b.rating - a.rating);
    embed.setDescription(
      best
        .map((s, i) => `**${i + 1}.** <@${s.discordId}> — **${fmtRange(s)}** · ${s.nEff} eff. games`)
        .join('\n') +
        // Ranking people whose ranges overlap is ranking them by luck, and the
        // leaderboard should say so rather than let the ordering imply a gap
        // that is not there.
        (overlapping(best)
          ? '\n-# Ranges that overlap are not a real ordering — those players cannot be told apart on the games played.'
          : '')
    );
  } else {
    embed.setDescription(
      `Nobody has ${minEffectiveGames} recent games' worth of form yet, so there is nothing to rank.`
    );
  }

  // Shown rather than hidden: "where is my name" is a worse question than
  // "how many more games until I show up".
  if (provisional.length > 0) {
    embed.addFields({
      name: `⏳ Not enough recent games yet (${minEffectiveGames} effective needed)`,
      value: provisional.map((s) => `-# <@${s.discordId}> — ${s.nEff}`).join('\n'),
      inline: false
    });
  }

  const notes = [];
  if (!shrinkage.estimable) notes.push("the squad's scores aren't yet separable from noise");
  if (excluded > 0) notes.push(`${excluded} game${excluded === 1 ? '' : 's'} not sound enough to rank on`);

  embed.setFooter({
    text:
      'Each player over their OWN last games, weighted toward recent ones · 50 = did your job for your role\n' +
      'Same rating /worst uses, so the two never disagree' +
      (notes.length ? ` · ${notes.join(' · ')}` : '')
  });

  await interaction.reply({ embeds: [embed] });
}

/** True if any adjacent pair in the ordering has overlapping ranges. */
function overlapping(sorted) {
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].low < sorted[i + 1].high) return true;
  }
  return false;
}
