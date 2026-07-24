// src/commands/run-command.ts

import { commands } from './commands.js';
import type { CommandContext } from './context.js';

export async function runCommand(input: string, context: CommandContext) {
  const trimmed = input.trim();

  if (!trimmed.startsWith('/')) {
    return false;
  }

  const [rawName, ...args] = trimmed.slice(1).split(/\s+/);
  const commandName = rawName.toLowerCase();

  const command = commands.find(
    (cmd) =>
      cmd.name === commandName ||
      cmd.aliases?.includes(commandName),
  );

  if (!command) {
    context.setMessages((prev) => [
      ...prev,
      {
        role: 'system',
        content: `
Unknown command: /${commandName}
Type /help to see available commands.`,
      },
    ]);

    return true;
  }

  await command.handler(args, context);
  return true;
}