import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { computeBenchRatings, benchVerdict } from '../benchRating.js';
import { config } from '../config.js';

export const data = new SlashCommandBuilder()
  .setName('worst')
  .setDescription('Show who should be benched based on recent form.');

const fmtRange = (p) => `${p.rating} \`[${p.low} – ${p.high}]\``;

export async function execute(interaction) {
  const { ranked, provisional, shrinkage, excluded, staleCalibration, minEffectiveGames } = computeBenchRatings({
    window: config.rollingWindow
  });

  if (ranked.length === 0 && provisional.length === 0) {
    // "No games" and "no games good enough" are different problems with
    // different fixes, and telling someone to run /fetchgame when they already
    // have forty stored games is the kind of answer that gets a bot ignored.
    if (excluded > 0) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('No bench call yet')
            .setColor(0x95a5a6)
            .setDescription(
              `${excluded} stored game${excluded === 1 ? ' was' : 's were'} set aside as not sound enough to bench on — ` +
                'scored without a timeline, or with a role the model was not sure of.\n' +
                '-# Those scores are still real and still show on `/profile`; they just cannot decide who sits out.'
            )
        ]
      });
      return;
    }
    await interaction.reply('No scored games yet — run `/fetchgame` after your next match.');
    return;
  }

  // The minimum matters most here. Benching someone off one or two games is
  // acting on noise, and it's the one thing this command exists to get right.
  // It is measured in *effective* games, so six games where five are months old
  // does not qualify anyone.
  if (ranked.length === 0) {
    const closest = provisional
      .map((s) => `-# <@${s.discordId}> — ${s.nEff} of ${minEffectiveGames} effective games`)
      .join('\n');
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('No bench call yet')
          .setColor(0x95a5a6)
          .setDescription(
            `Nobody has ${minEffectiveGames} recent games' worth of form, which isn't enough to bench anyone on.\n${closest}`
          )
      ]
    });
    return;
  }

  const verdict = benchVerdict(ranked);
  const worst = verdict.worst;

  const embed = new EmbedBuilder();

  if (!verdict.decisive) {
    // The honest answer, and the one this command most often owes the squad.
    // Naming one of two players who are three points apart with seven-point
    // error bars is picking by luck and calling it a measurement.
    const group = [worst, ...verdict.tied];
    embed
      .setTitle('🤝 Too close to call')
      .setColor(0x95a5a6)
      .setDescription(
        `${group.map((p) => `<@${p.discordId}>`).join(' and ')} cannot be told apart on the games played.\n` +
          `-# Their ranges overlap by ${verdict.overlap}%, over the ${Math.round(verdict.tolerance * 100)}% where a gap stops meaning anything.`
      )
      .addFields({
        name: 'Ratings (95% range)',
        value: group.map((p) => `<@${p.discordId}> — **${fmtRange(p)}** · ${p.nEff} eff. games`).join('\n'),
        inline: false
      });
  } else {
    const runnerUp = ranked[1] ?? null;
    embed
      .setTitle('🪑 Bench recommendation')
      .setColor(0xe67e22)
      .setDescription(
        `<@${worst.discordId}> has the lowest form: **${fmtRange(worst)}** over ${worst.nEff} effective games.` +
          (runnerUp ? `\n-# Next lowest is <@${runnerUp.discordId}> at ${fmtRange(runnerUp)}.` : '')
      );
  }

  embed.addFields({
    name: 'Recent scores',
    value: worst.recentScores.map((s) => s.toFixed(1)).join(' · '),
    inline: false
  });

  // A bench call with no visible reason is the voice-chat blame problem with
  // extra latency. Three claims, each of which can be argued with: what they
  // averaged, what the rest of the squad averaged on the same component, and
  // whether it is a pattern or one bad night.
  const scored = worst.byComponent.filter((c) => c.reliable);
  const gapByKey = new Map(worst.gap.map((c) => [c.key, c]));
  const weakest = scored.filter((c) => c.average < 47).slice(0, 3);
  const strongest = [...scored].reverse().filter((c) => c.average >= 50).slice(0, 2);
  // Against the squad where that comparison exists (spec §8.3), and on its own
  // where it does not — a component only this player has ever been scored on
  // still says something.
  const fmt = (c) => {
    const g = gapByKey.get(c.key);
    return g ? `${c.label} ${c.average} · squad ${g.field} (${g.delta})` : `${c.label} ${c.average}`;
  };

  const persistent = weakest.find((c) => c.weakGames >= Math.ceil(c.games * 0.6) && c.weakGames >= 3);

  if (weakest.length > 0) {
    embed.addFields({
      name: '🔻 Consistently weak',
      value:
        weakest.map(fmt).join('\n') +
        (strongest.length ? `\n-# Fine at: ${strongest.map((c) => `${c.label} ${c.average}`).join(' · ')}` : '') +
        (persistent
          ? `\n-# ${persistent.label} has been under 45 in ${persistent.weakGames} of ${persistent.games} games — that's the pattern, not one bad night.`
          : ''),
      inline: false
    });
  } else if (scored.length > 0) {
    // Nothing is actually broken; they're just the lowest of a close group. The
    // squad comparison still runs, because "behind the others at X" is a real
    // finding even when nothing is below par in absolute terms.
    const behind = worst.gap.slice(0, 2);
    embed.addFields({
      name: '🔻 Consistently weak',
      value:
        `-# Nothing stands out — no component averages below 47 over ${worst.gamesPlayed} games.` +
        (behind.length ? `\n-# Furthest behind the squad: ${behind.map(fmt).join(' · ')}` : ''),
      inline: false
    });
  }

  const notes = [];
  if (!shrinkage.estimable) {
    notes.push(
      shrinkage.sigmaBetween === 0
        ? "the squad's scores aren't yet separable from noise, so ratings are pulled hard toward each player's own average"
        : 'not enough history to measure the squad’s spread, so a default is assumed'
    );
  }
  if (excluded > 0) notes.push(`${excluded} game${excluded === 1 ? '' : 's'} ignored (no timeline, or an uncertain role)`);
  if (staleCalibration > 0) {
    notes.push(`${staleCalibration} player${staleCalibration === 1 ? ' has' : 's have'} games from an older calibration — \`/resetgames\` re-scores them`);
  }

  embed.setFooter({
    text:
      `Recency-weighted over each player's last ${config.rollingWindow} games · ` +
      `minimum ${minEffectiveGames} effective` +
      (notes.length ? `\n${notes.join(' · ')}` : '')
  });

  if (provisional.length > 0) {
    embed.addFields({
      name: `⏳ Not eligible (${minEffectiveGames} effective games needed)`,
      value: provisional.map((s) => `-# <@${s.discordId}> — ${s.nEff}`).join('\n'),
      inline: false
    });
  }

  await interaction.reply({ embeds: [embed] });
}
