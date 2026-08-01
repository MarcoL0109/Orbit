import { commands } from './commands.js';

export function getCommandSuggestions(input: string) {
    const trimmed = input.trim();

    if (!trimmed.startsWith('/')) {
        return [];
    }
    const commandPart = trimmed.slice(1).toLowerCase();
    if (!commandPart) {
        return commands;
    }
    return commands.filter((command) => {
        const nameMatches = command.name.startsWith(commandPart);
        const aliasMatches = command.aliases?.some((alias) =>
            alias.startsWith(commandPart),
        );
        return nameMatches || aliasMatches;
    });
}


export function getBestCommandCompletion(input: string) {
    const suggestions = getCommandSuggestions(input);
    if (suggestions.length !== 1) {
        return null;
    }
    return `/${suggestions[0].name}`;
}


export function getGhostCompletion(input: string) {
    const completion = getBestCommandCompletion(input);

    if (!completion) {
        return null;
    }

    if (!completion.startsWith(input)) {
        return null;
    }

    return completion.slice(input.length);
}