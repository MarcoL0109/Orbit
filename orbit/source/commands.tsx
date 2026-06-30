export type OrbitCommand = {
    name: string;
    aliases?: string[];
    description: string;
    usage: string;
    handler: (input: string) => Promise<void> | void;
};

export const commands: OrbitCommand[] = [
    {
        name: 'help',
        aliases: ['h'],
        description: 'Show available Orbit commands',
        usage: '/help',
        handler: async () => {
            // show help
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