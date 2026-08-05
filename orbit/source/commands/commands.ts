import type { CommandContext } from "./context.js";
import {readGlobalProjects, formatProjectsForTui} from '../registry/knownProjects.js';
import { getProjectDisplayName } from "../projects/search.js";
import { runTestingAgent, formatAgentRunResult, describeAgentActivity } from '../ai/agent.js';
import { writeAgentSession } from '../ai/session.js';
import { readOrbitConfig } from '../init/config.js';
import {scanProject, writeProjectMap} from '../projects/scan.js';
import { getProjectPath } from '../init/deinit.js';
import { formatScanResult } from "../projects/scan.js";
import { computeCoverage, formatCoverageSummary, describeCoverageEntry, colorForCoverageStatus, type CoverageEntry } from '../projects/coverage.js';
import { reportError, type ArgCountRule } from './error.js';


export type OrbitCommand = {
    name: string;
    aliases?: string[];
    description: string;
    usage: string;
    argsRule: ArgCountRule;
    // Commands the user must always be able to run, even while another
    // command is mid-flight — currently only /abort.
    bypassBusyCheck?: boolean;
    handler: (args: string[], context: CommandContext) => Promise<void> | void;
};


export const commands: OrbitCommand[] = [
    {
        name: 'help',
        aliases: ['h'],
        description: 'Show available Orbit commands',
        usage: '/help',
        argsRule: {exact: 0},
        handler: async (_args, context) => {
            context.setMessages((prev) => [
                ...prev,
                {
                    role: 'system',
                    content: `
Available Orbit commands:
/help       Show available commands
/switch     Switch Orbit to work on a different project
/init       Initialize Orbit for this project
/deinit     Delete the .orbit folder within the current project
/scan       Build index and context for the current project
/test       Generate and run a Playwright test for a feature you describe
/coverage   Show routes and components that don't have a matching test
/projects   Show remembered projects
/memory     Show project memory
/clear      Clear the screen
/abort      Abort ongoing tasks that is currently running
/exit       Exit Orbit`,
                },
            ])
        },
    },

    {
        name: 'init',
        description: 'Create .orbit project context',
        usage: '/init',
        argsRule: {exact: 0},
        handler: async (_args, context) => {
            if (!context.project) {
                reportError(context.setMessages, {kind: 'no-project-selected'});
                return;
            }

            if (context.project.hasOrbitFolder) {
                reportError(context.setMessages, {kind: 'project-already-initialized'});
                return;
            }

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
        argsRule: {exact: 0},
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
            } catch (error) {
                reportError(context.setMessages, {
                    kind: 'unexpected',
                    action: 'Reading projects.json',
                    cause: error,
                });
            }
        },
    },

    {
        name: 'exit',
        description: 'Exit Orbit',
        usage: '/exit',
        argsRule: {exact: 0},
        handler: (_args, _context) => {
            process.exit(0);
        },
    },

    {
        name: 'clear',
        description: 'Clear Orbit terminal screen',
        usage: '/clear',
        argsRule: {exact: 0},
        handler: (_args, context) => {
            context.setMessages([]);
        }
    },

    {
        name: "switch",
        description: "Switch Orbit to work on a different project",
        usage: '/switch',
        argsRule: {exact: 0},
        handler: (_args, context) => {
            context.setSelectProjectMode(true);
            const options = context.constructProjectOptions();
            context.setProjectOptions(options);
        }
    },

    {
        name: "test",
        description: "Generate and run a Playwright test for a feature you describe",
        usage: '/test <prompt>',
        argsRule: {min: 1},
        handler: async (_args, context) => {
            const prompt = _args.join(' ').trim();

            if (!context.project?.root) {
                reportError(context.setMessages, {kind: 'no-project-selected'});
                return;
            }

            const orbitConfig = context.project.hasOrbitFolder
                ? readOrbitConfig(context.project.root)
                : null;

            if (!orbitConfig) {
                reportError(context.setMessages, {kind: 'project-not-initialized'});
                return;
            }

            try {
                context.setIsThinking(true);
                const controller = context.startAbortableTask();

                // Keep the project index fresh before every run — cheap in
                // practice since scanProject skips unchanged files by
                // mtime/size, and non-fatal if it fails: the agent still
                // works from whatever map (if any) was already on disk.
                try {
                    context.setAgentActivity('Scanning project for changes...');
                    const projectMap = await scanProject(context.project.root);
                    writeProjectMap(context.project.root, projectMap);
                } catch (error) {
                    reportError(context.setMessages, {
                        kind: 'unexpected',
                        action: 'Pre-test project scan',
                        cause: error,
                    });
                }

                context.setAgentActivity('Analyzing the request...');

                const result = await runTestingAgent(prompt, {
                    projectRoot: context.project.root,
                    orbitConfig,
                    signal: controller.signal,
                    requestApproval: context.requestApproval,
                    requestInput: context.requestInput,
                }, {
                    onProgress: (event) => context.setAgentActivity(describeAgentActivity(event)),
                });

                writeAgentSession(context.project.root, prompt, result);

                context.setMessages((prev) => [
                    ...prev,
                    {
                        role: 'agent',
                        content: formatAgentRunResult(result),
                        color: result.status === 'passed' ? 'green' : result.status === 'aborted' ? 'yellow' : 'red',
                    },
                ]);
            } catch (error) {
                reportError(context.setMessages, {
                    kind: 'unexpected',
                    action: 'Test agent run',
                    cause: error,
                });
            } finally {
                context.setIsThinking(false);
                context.setAgentActivity(null);
                context.clearAbortableTask();
            }
        }
    },

    {
        name: "abort",
        description: "Aborting on going tasks",
        usage: "/abort",
        argsRule: {exact: 0},
        bypassBusyCheck: true,
        handler: (_args, context) => {
            const didAbort = context.abortCurrentTask();
            context.setMessages((prev) => [
                ...prev,
                {
                    role: 'system',
                    content: didAbort
                    ? 'Aborting current task...'
                    : 'No running task to abort.',
                    color: didAbort ? 'yellow' : 'red',
                },
            ]);
        }
    },
    {
        name: 'scan',
        description: 'Scan the current project',
        usage: '/scan',
        argsRule: {exact: 0},
        handler: async (_args, context) => {
            if (!context.project?.root) {
                reportError(context.setMessages, {kind: 'no-project-selected'});
                return;
            }
            try {
                context.setIsThinking(true);

                const projectMap = await scanProject(context.project.root);
                const projectMapPath = writeProjectMap(context.project.root, projectMap);

                context.setMessages((prev) => [
                ...prev,
                {
                    role: 'agent',
                    content: formatScanResult(projectMap, projectMapPath),
                    color: 'green',
                },
                ]);
            } catch (error) {
                reportError(context.setMessages, {
                    kind: 'unexpected',
                    action: 'Project scan',
                    cause: error,
                });
            } finally {
                context.setIsThinking(false);
            }
        }
    },
    {
        name: 'coverage',
        description: "Show routes and components that don't have a matching test",
        usage: '/coverage',
        argsRule: {exact: 0},
        handler: async (_args, context) => {
            if (!context.project?.root) {
                reportError(context.setMessages, {kind: 'no-project-selected'});
                return;
            }

            // Rescan first, not just read the last project-map.json — a
            // test file written by a prior /test run didn't exist yet at
            // that run's own pre-test rescan, so it (and its checksum)
            // would be missing from a stale index entirely, not just
            // outdated.
            let projectMap;

            try {
                context.setIsThinking(true);
                context.setAgentActivity('Scanning project for changes...');
                projectMap = await scanProject(context.project.root);
                writeProjectMap(context.project.root, projectMap);
            } catch (error) {
                reportError(context.setMessages, {
                    kind: 'unexpected',
                    action: 'Pre-coverage project scan',
                    cause: error,
                });
                return;
            } finally {
                context.setIsThinking(false);
                context.setAgentActivity(null);
            }

            const report = computeCoverage(projectMap, context.project.root);

            function entryMessage(entry: CoverageEntry) {
                return {
                    role: 'agent' as const,
                    content: describeCoverageEntry(entry),
                    color: colorForCoverageStatus(entry.status),
                };
            }

            context.setMessages((prev) => [
                ...prev,
                {role: 'agent', content: formatCoverageSummary(report)},
                ...(report.routes.length > 0
                    ? [{role: 'agent' as const, content: `Routes (${report.routes.length}):`}, ...report.routes.map(entryMessage)]
                    : []),
                ...(report.components.length > 0
                    ? [{role: 'agent' as const, content: `Components (${report.components.length}):`}, ...report.components.map(entryMessage)]
                    : []),
            ]);
        }
    },
    // This command will remove .orbit folder and its record in the global memory in projects.json
    // Rmb to make a user confirmation prompt
    {
        name: 'deinit',
        description: 'This command delete .orbit context for a particular project',
        usage: '/deinit',
        argsRule: {exact: 0},
        handler: (_args, context) => {
            const projectPath = getProjectPath(context.project);
            if (!projectPath.ok) {
                reportError(context.setMessages, {kind: 'no-project-selected'});
                return;
            }
            context.setConfirmDeinit(true);
        }
    }
];
