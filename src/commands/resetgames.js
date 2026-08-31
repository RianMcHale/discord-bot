import { SlashCommandBuilder } from 'discord.js';
import { db } from '../storage.js';
import { isAdmin } from '../config.js';

// /fetchgame scores at most this many games per run, so a bigger reset needs
// more than one pass. Kept in step with MAX_PER_RUN in fetchgame.js.
const FETCH_PER_RUN = 5;

/** A generous lookback for re-finding N squad games: solo queue sits in between. */
const suggestedLookback = (n) => Math.max(10, n * 2);

const dayStamp = (ms) => `<t:${Math.floor(ms / 1000)}:d>`;

export const data = new SlashCommandBuilder()
  .setName('resetgames')
  .setDescription('Clear scored game history so it can be re-scored. Keeps registered players. Restricted.')
  .addStringOption((opt) => opt.setName('confirm').setDescription('Type RESET to confirm').setRequired(true))
  .addIntegerOption((opt) =>
    opt
      .setName('last')
      .setDescription('Only clear the N most recent games, for re-scoring after a scoring change')
      .setMinValue(1)
      .setRequired(false)
  );

export async function execute(interaction) {
  // Checked before the confirmation text: someone without permission shouldn't
  // learn whether they got the magic word right.
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({
      content:
        "`/resetgames` wipes scored history and can't be undone, so it's restricted to the bot owner.",
      ephemeral: true
    });
    return;
  }

  if (interaction.options.getString('confirm') !== 'RESET') {
    await interaction.reply({
      content: 'Not reset — you must type `RESET` exactly in the confirm field to proceed.',
      ephemeral: true
    });
    return;
  }

  const last = interaction.options.getInteger('last');
  const stored = db.allGames(); // ascending by playedAt

  if (stored.length === 0) {
    await interaction.reply({ content: 'Nothing to clear — there are no scored games stored.' });
    return;
  }

  // --- full wipe ------------------------------------------------------------
  if (last === null) {
    db.resetGames();
    await interaction.reply({
      content:
        `✅ Cleared **${stored.length}** scored game${stored.length === 1 ? '' : 's'}. ` +
        'Registered players were kept. Next `/fetchgame` starts fresh.'
    });
    return;
  }

  // --- partial reset, for re-scoring ---------------------------------------
  const doomed = stored.slice(-last); // the N most recent
  const removed = db.removeGames(doomed.map((g) => g.matchId));
  const oldest = doomed[0];
  const lookback = suggestedLookback(removed);

  const kept = stored.length - removed;
  const lines = [
    `✅ Cleared the **${removed}** most recent scored game${removed === 1 ? '' : 's'}` +
      (removed < last ? ` (only ${removed} ${removed === 1 ? 'was' : 'were'} stored)` : '') +
      `, back to ${dayStamp(oldest.playedAt)}. ` +
      (kept > 0 ? `The **${kept}** older game${kept === 1 ? '' : 's'} were kept.` : 'That was all of them.'),
    '',
    'Re-score them with:'
  ];

  // Each /fetchgame pass is capped, so a bigger reset needs repeat runs.
  if (removed <= FETCH_PER_RUN) {
    lines.push(`\`/fetchgame count:${removed} lookback:${lookback}\``);
  } else {
    const runs = Math.ceil(removed / FETCH_PER_RUN);
    lines.push(
      `\`/fetchgame count:${FETCH_PER_RUN} lookback:${lookback}\` — run it **${runs}×**, ` +
        `since each pass scores at most ${FETCH_PER_RUN}.`
    );
  }

  lines.push(
    '',
    'Raise `lookback` if a game does not come back: it counts *each player\'s* recent matches, ' +
      'so solo queue played since then pushes squad games out of the window.',
    '',
    '⚠️ The watcher will also pick these up on its next scan, so they may re-post to the ' +
      'watch channel on their own after the next game finishes.'
  );

  await interaction.reply({ content: lines.join('\n') });
}
