import { REST, Routes } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const commandsDir = path.join(__dirname, 'commands');
  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));

  const commandJSON = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
    commandJSON.push(mod.data.toJSON());
  }

  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  const route = config.discordGuildId
    ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
    : Routes.applicationCommands(config.discordClientId);

  console.log(`Deploying ${commandJSON.length} command(s) ${config.discordGuildId ? 'to guild ' + config.discordGuildId : 'globally (may take up to 1hr to appear)'}...`);
  await rest.put(route, { body: commandJSON });
  console.log('Done.');
}

main().catch((err) => {
  console.error('Failed to deploy commands:', err);
  process.exit(1);
});
