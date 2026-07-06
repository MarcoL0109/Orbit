import type { CommandContext } from "./context.js";
import { initOrbitProject } from '../init/init.js';
import type { InitFileAction } from '../init/init.js';
import {readGlobalProjects, formatProjectsForTui} from '../projects/read.js';



export type OrbitCommand = {
    name: string;
    aliases?: string[];
    description: string;
    usage: string;
    handler: (args: string[], context: CommandContext) => Promise<void> | void;
};


export function formatInitResult(files: InitFileAction[]) {
    const created = files.filter((file) => file.action === 'created');
    const createdText =
    created.length > 0
        ? created.map((file) => `✓ ${file.relativePath}`).join('\n')
        : 'None';

    return `Orbit initialized this project.

Created:
${createdText}

Next:
Run /scan to build the project index.`;
}


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
        aliases: ['scan'],
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
        handler: async (_args, context) => {
            // Not fully done yet, still need some TUI display to indicate is either initializing, success or failed
            // Also can't really allow user to use this command if it is not in a valid project, but if user is not in a project they are forced to select one at the beginning so is this still an issue??
            // And error checking...
            // Also when the .orbit folder is in here, if user want to re-initialize again, we need to ask for confirmation
            if (context.project && !context.project.hasOrbitFolder) {
                try {
                    context.setIsInitting(true);
                    const result = initOrbitProject({projectName: "Orbit", projectRoot: context.project?.root || process.cwd()});
                    context.setIsInitting(false);
                    context.setMessages((prev) => [
                        ...prev,
                        {
                            role: 'agent',
                            content: formatInitResult(result.files),
                            color: 'green',
                        },
                    ]);
                    context.project.hasOrbitFolder = true;
                } catch (error) {
                    context.setMessages([
                        {
                            role: 'system',
                            content: `Fail to Initalize Orbit Context`,
                            color: 'red'
                        },
                    ]);
                }
            } else if (context.project?.hasOrbitFolder) {
                context.setMessages((prev) => [
                    ...prev,
                    {
                        role: 'system',
                        content: `Orbit context is initialized. You can use /scan to refresh the context or delete .orbit folder and do /init again`,
                        color: 'yellow',
                    },
                ]);
            }
        },
    },
    {
        name: 'projects',
        description: 'Show remembered projects',
        usage: '/projects',
        handler: async (_args, context) => {
            try {
                const projectsFile = readGlobalProjects();
                const content = formatProjectsForTui(projectsFile);

                context.setMessages((prev) => [
                    ...prev,
                    {
                    role: 'agent',
                    content,
                    },
                ]);
                } 
            catch (error) {
                context.setMessages((prev) => [
                    ...prev,
                    {
                    role: 'agent',
                    content: `Could not read projects.json: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    },
                ]);
            }
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