import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { config } from './config.js';
import { db, dbPath } from './storage.js';
import { loadCommands, registerCommands } from './commandRegistry.js';
import { startWatcher } from './watcher.js';
import { purgeUnsupportedGames } from './maintenance.js';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(
    `Data store: ${dbPath} — ${db.allPlayers().length} player(s), ${db.allGames().length} scored game(s)`
  );

  // Games scored before queue filtering existed would otherwise keep skewing
  // every average. Only queues that are known-unsupported are removed.
  const purged = purgeUnsupportedGames();
  if (purged.removed > 0) {
    const detail = Object.entries(purged.byQueue)
      .map(([name, n]) => `${n}× ${name}`)
      .join(', ');
    console.log(`Removed ${purged.removed} game(s) from unsupported queues: ${detail}`);
  }

  // Registering here means adding or changing a command only needs a deploy —
  // there's no separate step to forget. It's hashed, so a restart that changed
  // nothing doesn't hit Discord at all.
  try {
    const result = await registerCommands(client.commands);
    console.log(
      result.registered
        ? `Registered ${result.count} command(s) to ${result.scope}`
        : `Commands up to date (${result.count}) — ${result.reason}`
    );
  } catch (err) {
    // Non-fatal: whatever was registered previously still works, and the bot is
    // more useful running with slightly stale commands than not running at all.
    console.error('Command registration failed, continuing with previously registered commands:', err.message);
  }

  startWatcher(client);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error running /${interaction.commandName}:`, err);
    const payload = { content: 'Something went wrong running that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

const commands = await loadCommands();
for (const [name, mod] of commands) client.commands.set(name, mod);
console.log(`Loaded ${commands.size} command(s): ${[...commands.keys()].join(', ')}`);

client.login(config.discordToken);
