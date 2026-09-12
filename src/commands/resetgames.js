import { SlashCommandBuilder } from 'discord.js';
import { db } from '../storage.js';
import { config, isAdmin } from '../config.js';
import { coverage } from '../rescore.js';

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
      .setDescription('Only clear the N most recent games. For re-scoring, prefer /rescore — it keeps the history')
      .setMinValue(1)
      .setRequired(false)
  )
  .addBooleanOption((opt) =>
    opt
      .setName('force')
      .setDescription('Delete anyway, even where /rescore could fix them in place without losing the game')
      .setRequired(false)
  )
  .addBooleanOption((opt) =>
    opt
      .setName('duplicates')
      .setDescription('Remove only games stored more than once, keeping one copy of each')
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
  const duplicatesOnly = interaction.options.getBoolean('duplicates') ?? false;
  const force = interaction.options.getBoolean('force') ?? false;
  const stored = db.allGames(); // ascending by playedAt

  // Clearing games so they can be re-fetched was the only way to apply a scoring
  // change before the payloads were archived. It is now the worse way and often
  // an impossible one: the seven-day fetch window means anything older simply
  // does not come back, so a reset can delete history it cannot replace.
  if (!duplicatesOnly && !force) {
    const cov = coverage();
    if (cov.covered > 0) {
      await interaction.reply({
        content:
          `⚠️ **\`/rescore\` is probably what you want.** ${cov.covered} of ${cov.stored} stored games can be ` +
          're-scored in place with the current model — same result, nothing deleted, no Riot API calls.\n\n' +
          `Clearing them means re-fetching, and the ${config.maxGameAgeDays}-day fetch window will not return ` +
          'anything older than that. This can delete history it cannot bring back.\n' +
          '-# If you genuinely want them gone, run it again with `force:true`.',
        ephemeral: true
      });
      return;
    }
  }

  if (stored.length === 0) {
    await interaction.reply({ content: 'Nothing to clear — there are no scored games stored.' });
    return;
  }

  // --- duplicates only ------------------------------------------------------
  if (duplicatesOnly) {
    const groups = db.duplicateGroups();
    if (groups.length === 0) {
      await interaction.reply({
        content:
          `No duplicates among the **${stored.length}** stored game${stored.length === 1 ? '' : 's'}. ` +
          'Games are matched on Riot’s numeric game id, falling back to who played and when for older rows.'
      });
      return;
    }

    const doomed = groups.flatMap((g) => g.remove);
    const removed = db.removeGames(doomed.map((g) => g.matchId));

    // Name what was merged into what: a silent count of deletions on the one
    // command that cannot be undone is not enough to check the call was right.
    const lines = groups.slice(0, 10).map((g) => {
      const dropped = g.remove.map((r) => `\`${r.matchId}\``).join(', ');
      return `-# ${dayStamp(g.keep.playedAt)} — kept \`${g.keep.matchId}\`, removed ${dropped}`;
    });
    if (groups.length > 10) lines.push(`-# …and ${groups.length - 10} more group${groups.length - 10 === 1 ? '' : 's'}.`);

    await interaction.reply({
      content: [
        `✅ Removed **${removed}** duplicate${removed === 1 ? '' : 's'} across **${groups.length}** ` +
          `game${groups.length === 1 ? '' : 's'}, keeping one copy of each. ` +
          `**${stored.length - removed}** game${stored.length - removed === 1 ? '' : 's'} remain.`,
        '',
        ...lines,
        '',
        '-# New scans now check Riot’s numeric game id as well as the match id, so a game ' +
          'handed back under two ids is only scored once. This should not recur.'
      ].join('\n')
    });
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
