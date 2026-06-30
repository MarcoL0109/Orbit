import type { CommandContext } from "./context.js";


export type OrbitCommand = {
    name: string;
    aliases?: string[];
    description: string;
    usage: string;
    handler: (args: string[], context: CommandContext) => Promise<void> | void;
};


export const commands: OrbitCommand[] = [
    {
        name: 'help',
        aliases: ['h'],
        description: 'Show available Orbit commands',
        usage: '/help',
        handler: async (_args, context) => {
            context.setMessages((prev) => [
                ...prev,
                {
                    role: 'agent',
                    content: `Available Orbit commands:

                        /help       Show available commands
                        /init       Initialize Orbit for this project
                        /scan       Scan current project
                        /projects   Show remembered projects
                        /memory     Show project memory
                        /clear      Clear the screen
                        /exit       Exit Orbit`,
                },
            ])
        },
    },

    {
        name: 'scan',
        aliases: ['search'],
        description: 'Scan the current project',
        usage: '/scan',
        handler: async () => {
            // run scanProject()
        },
    },

    {
        name: 'init',
        description: 'Create .orbit project context',
        usage: '/init',
        handler: async () => {
            // initOrbitProject()
        },
    },
    {
        name: 'projects',
        description: 'Show remembered projects',
        usage: '/projects',
        handler: async () => {
            // show projects from ~/.orbit/projects.json
    },
    },
    {
        name: 'memory',
        description: 'Show project memory',
        usage: '/memory',
        handler: async () => {
            // read .orbit/memory
    },
    },
    {
        name: 'exit',
        aliases: ['quit', 'q'],
        description: 'Exit Orbit',
        usage: '/exit',
        handler: () => {
            process.exit(0);
        },
    },
];

export function parseCommand(input: string) {
    const trimmed = input.trim();

    if (!trimmed.startsWith('/')) {
        return null;
    }

    const [rawCommand, ...args] = trimmed.slice(1).split(/\s+/);
    if (rawCommand) {
        const commandName = rawCommand.toLowerCase();
        const command = commands.find(
            (cmd) =>
                cmd.name === commandName ||
                cmd.aliases?.includes(commandName),
        );

        return {
            command,
            commandName,
            args,
            raw: trimmed,
        };
    }
    return null;
}