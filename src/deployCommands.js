// Standalone command registration. The bot also does this on startup, so this
// script is only needed to force a re-register without restarting.
import { loadCommands, registerCommands } from './commandRegistry.js';

const commands = await loadCommands();
const result = await registerCommands(commands, { force: true });
console.log(`Deployed ${result.count} command(s) to ${result.scope}.`);
