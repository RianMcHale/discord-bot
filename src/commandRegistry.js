// Loading and registering slash commands.
//
// Shared by the bot's startup and the standalone `npm run deploy-commands`
// script, so both see exactly the same command set.

import { REST, Routes } from 'discord.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from './config.js';
import { db } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Every module in commands/, keyed by slash command name. */
export async function loadCommands() {
  const commandsDir = path.join(__dirname, 'commands');
  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'));
  const commands = new Map();
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
    commands.set(mod.data.name, mod);
  }
  return commands;
}

function commandJSON(commands) {
  return [...commands.values()].map((m) => m.data.toJSON());
}

/**
 * Pushes the command set to Discord.
 *
 * @param {Map} commands
 * @param {object} opts
 * @param {boolean} opts.force  register even when nothing has changed
 * @returns {Promise<{registered: boolean, count: number, scope: string, reason?: string}>}
 */
export async function registerCommands(commands, { force = false } = {}) {
  const body = commandJSON(commands);
  const scope = config.discordGuildId ? `guild ${config.discordGuildId}` : 'globally (can take up to 1hr to appear)';

  // Registering is idempotent, but the bot restarts on every deploy and Discord
  // rate-limits command writes. Hashing the payload means a restart that didn't
  // change any command costs nothing.
  const hash = crypto.createHash('sha256').update(JSON.stringify({ body, scope })).digest('hex');
  if (!force && db.getMeta('commandHash') === hash) {
    return { registered: false, count: body.length, scope, reason: 'unchanged since last registration' };
  }

  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  const route = config.discordGuildId
    ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
    : Routes.applicationCommands(config.discordClientId);

  await rest.put(route, { body });
  db.setMeta('commandHash', hash);
  return { registered: true, count: body.length, scope };
}
