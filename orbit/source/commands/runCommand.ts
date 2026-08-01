import { commands } from './commands.js';
import type { CommandContext } from './context.js';
import { checkArgCount, checkTaskInProgress, reportError, type OrbitError } from './error.js';

export async function runCommand(input: string, context: CommandContext) {
  const trimmed = input.trim();

  if (!trimmed.startsWith('/')) {
    return false;
  }

  const [rawName, ...args] = trimmed.slice(1).split(/\s+/);
  const commandName = (rawName ?? '').toLowerCase();

  const command = commands.find(
    (cmd) =>
      cmd.name === commandName ||
      cmd.aliases?.includes(commandName),
  );

  if (!command) {
    reportError(context.setMessages, {kind: 'unknown-command', commandName});
    return true;
  }

  let error: OrbitError | null = null;

  if (!command.bypassBusyCheck) {
    error = checkTaskInProgress(context);
  }

  if (!error) {
    error = checkArgCount(command.argsRule, args.length, command.usage);
  }

  if (error) {
    reportError(context.setMessages, error);
    return true;
  }

  await command.handler(args, context);
  return true;
}
