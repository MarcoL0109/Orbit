import type { CommandContext } from "./context.js";
import {readGlobalProjects, formatProjectsForTui} from '../projects/readProjectMem.js';
import { getProjectDisplayName } from "../projects/search.js";



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
                    role: 'system',
                    content: `Available Orbit commands:
/help       Show available commands
/switch     Switch Orbit to work on a different project
/init       Initialize Orbit for this project
/projects   Show remembered projects
/memory     Show project memory
/clear      Clear the screen
/exit       Exit Orbit`,
                },
            ])
        },
    },

    {
        name: 'init',
        description: 'Create .orbit project context',
        usage: '/init',
        handler: async (_args, context) => {
            if (!context.project) {
                context.setMessages((prev) => [
                ...prev,
                {
                    role: 'system',
                    content: 'No valid project selected. Please select or open a project first.',
                    color: 'red',
                },
                ]);
                return;
            }

            if (context.project.hasOrbitFolder) {
                context.setMessages((prev) => [
                ...prev,
                {
                    role: 'system',
                    content:
                    'Orbit context is already initialized. You can use /scan to refresh the context, or delete the .orbit folder and run /init again.',
                    color: 'yellow',
                },
                ]);
                return;
            }
            context.setIsInitting(true);
            let projectName = 'Default'
            if (context.project.root) {
                projectName = getProjectDisplayName(context.project.root);
            }

            context.setConfirmName(projectName);
            context.setCheckName(true);
        }
    },
    {
        name: 'projects',
        description: 'Show tracked projects',
        usage: '/projects',
        handler: async (_args, context) => {
            try {
                const projectsFile = readGlobalProjects();
                const content = formatProjectsForTui(projectsFile);

                context.setMessages((prev) => [
                    ...prev,
                    {
                        role: 'system',
                        content,
                    },
                ]);
                } 
            catch (error) {
                context.setMessages((prev) => [
                    ...prev,
                    {
                    role: 'system',
                    content: `Could not read projects.json: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    },
                ]);
            }
        },
    },
    {
        name: 'exit',
        description: 'Exit Orbit',
        usage: '/exit',
        handler: () => {
            process.exit(0);
        },
    },
    {
        name: 'clear',
        description: 'Clear Orbit terminal screen',
        usage: '/clear',
        handler: (_args, context) => {
            context.setMessages([]);
        }
    },
    {
        name: "switch",
        description: "Switch Orbit to work on a different project",
        usage: '/switch',
        handler: (_args, context) => {
            context.setSelectProjectMode(true);
            const options = context.constructProjectOptions();
            context.setProjectOptions(options);
        }
    }

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