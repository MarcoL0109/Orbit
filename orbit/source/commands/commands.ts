import process from 'node:process';
import {
	readGlobalProjects,
	formatProjectsForTui,
} from '../registry/knownProjects.js';
import {getProjectDisplayName, detectProjectAtPath} from '../projects/search.js';
import {
	describeAgentActivity,
	summarizeMemory,
	type MemorySections,
} from '../ai/agent.js';
import {runAskAgent} from '../ai/askAgent.js';
import {
	readOrbitConfig,
	writeOrbitConfig,
	type OrbitConfig,
} from '../init/config.js';
import {readProjectMemory} from '../init/memory.js';
import {writeProjectMap, formatScanResult} from '../projects/scan.js';
import {
	scanProjectWithModeSelection,
	graphifyOutcomeMessage,
	runGraphifyAndGetOutcome,
} from '../projects/scanOrchestration.js';
import {getProjectPath} from '../init/deinit.js';
import {
	computeCoverage,
	formatCoverageSummary,
	describeCoverageEntry,
	colorForCoverageStatus,
	type CoverageEntry,
} from '../projects/coverage.js';
import {cleanupTrackedProcesses} from '../projects/processTracking.js';
import {runTestCommand} from './testCommand.js';
import type {CommandContext} from './context.js';
import {reportError, type ArgCountRule} from './error.js';

export {
	resolveEnvironmentSetupRoot,
	type TestCommandOutcome,
} from './testCommand.js';

// /config's editable fields — deliberately a subset of OrbitConfig.
// dockerComposeFile and dockerComposeHasHealthchecks are auto-detected
// facts, not preferences; testDir/manualTestDir are conventions other code
// paths assume are stable. scanMode IS included despite already having its
// own flow (/scan's picker) — that picker only ever fires once, while
// scanMode is still null; once it's set (correctly or by mistake, e.g. a
// stray keypress during the picker) there is otherwise no way to change it
// short of deleting .orbit/config.json by hand or a destructive
// /deinit + /init. Picking a new value here only persists the choice —
// the actual graphify build/install still only happens on the next real
// scan, exactly as if /scan's picker had been answered this way.
export type ConfigFieldDescriptor =
	| {key: 'approvalMode'; label: string; kind: 'enum'; options: string[]}
	| {key: 'writeMode'; label: string; kind: 'enum'; options: string[]}
	| {key: 'defaultBrowser'; label: string; kind: 'enum'; options: string[]}
	| {key: 'scanMode'; label: string; kind: 'enum'; options: string[]}
	| {key: 'baseUrl'; label: string; kind: 'text'; nullable: false}
	| {key: 'testCommand'; label: string; kind: 'text'; nullable: true}
	| {key: 'environmentSetupRoot'; label: string; kind: 'text'; nullable: true}
	| {key: 'maxRepairAttempts'; label: string; kind: 'number'}
	| {key: 'devCommands'; label: string; kind: 'csv'};

export const CONFIG_FIELDS: ConfigFieldDescriptor[] = [
	{
		key: 'approvalMode',
		label: 'Approval mode',
		kind: 'enum',
		options: ['ask', 'always'],
	},
	{
		key: 'writeMode',
		label: 'Write mode',
		kind: 'enum',
		options: ['ask', 'always'],
	},
	{
		key: 'defaultBrowser',
		label: 'Default browser',
		kind: 'enum',
		options: ['chromium', 'firefox', 'webkit'],
	},
	{
		key: 'scanMode',
		label: 'Scan mode',
		kind: 'enum',
		options: ['regex', 'graphify'],
	},
	{key: 'baseUrl', label: 'Base URL', kind: 'text', nullable: false},
	{key: 'testCommand', label: 'Test command', kind: 'text', nullable: true},
	{
		key: 'environmentSetupRoot',
		label: 'Environment setup root',
		kind: 'text',
		nullable: true,
	},
	{key: 'maxRepairAttempts', label: 'Max repair attempts', kind: 'number'},
	{key: 'devCommands', label: 'Dev commands', kind: 'csv'},
];

export function formatConfigFieldValue(
	config: OrbitConfig,
	field: ConfigFieldDescriptor,
): string {
	const value = config[field.key];
	if (value === null) return '(none)';
	if (Array.isArray(value))
		return value.length > 0 ? value.join(', ') : '(none)';
	return String(value);
}

// Only ever refreshes graphify — never triggers the interactive
// mode-selection prompt /scan and /test use, since a question typed as a
// bare prompt shouldn't suddenly ask the user to choose a scan mode. If
// graphify mode was already chosen, this keeps the graph explain_symbol
// reads from going stale between /test runs (or before one has ever
// happened); if it wasn't chosen yet, or the project isn't /init'd, this is
// a no-op. Non-fatal by the same reasoning /test's own pre-run scan uses —
// a failed refresh just means explain_symbol works off whatever graph (if
// any) was already on disk.
function refreshGraphifyIfEnabled(
	projectRoot: string,
	hasOrbitFolder: boolean | undefined,
	setMessages: CommandContext['setMessages'],
): void {
	if (!hasOrbitFolder) return;

	try {
		const orbitConfig = readOrbitConfig(projectRoot);
		if (orbitConfig?.scanMode !== 'graphify') return;

		const graphifyMessage = graphifyOutcomeMessage(
			runGraphifyAndGetOutcome(projectRoot),
		);
		if (!graphifyMessage) return;

		setMessages(previous => [...previous, {role: 'agent', ...graphifyMessage}]);
	} catch (error) {
		reportError(setMessages, {
			kind: 'unexpected',
			action: 'Refreshing the code graph',
			cause: error,
		});
	}
}

function formatConfigSummary(config: OrbitConfig): string {
	const lines = CONFIG_FIELDS.map(
		field => `${field.label}: ${formatConfigFieldValue(config, field)}`,
	);
	return `Current configuration:\n${lines.join('\n')}`;
}

// Handles a plain-text prompt (no leading /) — not a command, so it's called
// directly by app.tsx rather than dispatched through runCommand, but shaped
// like a command handler (same CommandContext, same try/finally cleanup) so
// it reuses the exact same busy/error/abort plumbing every real command
// already has. Deliberately lighter than /test's handler: no orbitConfig
// requirement, no environment reachability check, no full mode-selection
// scan — this works even before a project has been /init'd for anything
// that stays read-only (read_file, check_memory, check_coverage,
// refresh_project_scan). It also has access to run_test_command (the real
// /test, with real side effects), which is why the full CommandContext is
// passed through below rather than a narrower slice — that tool needs
// essentially everything a real /test invocation does, and every single
// call to it asks for approval on its own regardless.
export async function runAskFlow(
	prompt: string,
	context: CommandContext,
): Promise<void> {
	if (!context.project?.root) {
		reportError(context.setMessages, {kind: 'no-project-selected'});
		return;
	}

	const projectRoot = context.project.root;

	try {
		context.setIsThinking(true);
		const controller = context.startAbortableTask();

		refreshGraphifyIfEnabled(
			projectRoot,
			context.project.hasOrbitFolder,
			context.setMessages,
		);

		const result = await runAskAgent(
			prompt,
			{...context, projectRoot, signal: controller.signal},
			{
				onProgress(event) {
					context.setAgentActivity(describeAgentActivity(event));
				},
			},
		);

		if (result.status === 'aborted') {
			context.setMessages(previous => [
				...previous,
				{role: 'agent', content: `Aborted: ${result.answer}`, color: 'yellow'},
			]);
			return;
		}

		context.setMessages(previous => [
			...previous,
			{
				role: 'agent',
				content: result.answer,
				color: result.status === 'gave_up' ? 'yellow' : undefined,
			},
		]);
	} catch (error) {
		reportError(context.setMessages, {
			kind: 'unexpected',
			action: 'Ask',
			cause: error,
		});
	} finally {
		context.setIsThinking(false);
		context.setAgentActivity(null);
		context.clearAbortableTask();
	}
}

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
		async handler(_args, context) {
			context.setMessages(previous => [
				...previous,
				{
					role: 'system',
					content: `
Available Orbit commands:
/help       Show available commands
/switch     Switch Orbit to work on a different project
/init [path] Initialize Orbit — confirms the detected path first, or trusts an explicit one. Path is optional. If left empty, orbit will suggest one for you
/deinit     Delete the .orbit folder within the current project
/scan       Build index and context for the current project
/config     View and change project configuration
/test       Generate and run a Playwright test for a feature you describe
/coverage   Show routes and components that don't have a matching test
/projects   Show remembered projects
/memory     Show project memory (--overview / --decisions / --failures to filter, default all)
/clear      Clear the screen
/abort      Abort ongoing tasks that is currently running
/exit       Exit Orbit`,
				},
			]);
		},
	},

	{
		name: 'init',
		description:
			'Create .orbit project context. With no path, auto-detects and asks you to confirm (or edit) it first. An explicit path skips that confirmation and is trusted directly — bypassing auto-detection entirely — for cases (a polyglot monorepo, a nested frontend) where auto-detection picks the wrong root or none at all.',
		usage: '/init [path]',
		argsRule: {min: 0},
		async handler(args, context) {
			if (args.length > 1) {
				reportError(context.setMessages, {
					kind: 'invalid-arg-count',
					usage: '/init [path]',
					expected: '0 or 1',
					given: args.length,
				});
				return;
			}

			const explicitPath = args[0];

			if (explicitPath) {
				const project = detectProjectAtPath(explicitPath);

				if (!project.isProject || !project.root) {
					reportError(context.setMessages, {
						kind: 'invalid-project-path',
						path: explicitPath,
					});
					return;
				}

				if (project.hasOrbitFolder) {
					reportError(context.setMessages, {
						kind: 'project-already-initialized',
					});
					return;
				}

				context.setProject(project);
				context.setMessages(previous => [
					...previous,
					{role: 'system', content: `Initializing at: ${project.root}`},
				]);
				context.setConfirmName(getProjectDisplayName(project.root));
				context.setCheckName(true);
				return;
			}

			// No path given. If boot-time auto-detection already found an
			// initialized project here, keep the fast, no-typing error rather
			// than asking the user to confirm a path we already know is a
			// no-op — that confirmation step exists for the uncertain case,
			// not this one.
			if (context.project?.isProject && context.project.hasOrbitFolder) {
				reportError(context.setMessages, {kind: 'project-already-initialized'});
				return;
			}

			// Otherwise offer the best guess available — the auto-detected
			// root if detection succeeded, or plain cwd if it didn't — for the
			// user to confirm or edit, rather than failing outright the way a
			// missing/low-confidence auto-detection used to.
			const suggestedPath = context.project?.root ?? process.cwd();
			context.setConfirmInitPath(suggestedPath);
			context.setCheckInitPath(true);
		},
	},

	{
		name: 'projects',
		description: 'Show tracked projects',
		usage: '/projects',
		argsRule: {exact: 0},
		async handler(_args, context) {
			try {
				const projectsFile = readGlobalProjects();
				const content = formatProjectsForTui(projectsFile);

				context.setMessages(previous => [
					...previous,
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
		handler(_args, _context) {
			cleanupTrackedProcesses();
			process.exit(0);
		},
	},

	{
		name: 'clear',
		description: 'Clear Orbit terminal screen',
		usage: '/clear',
		argsRule: {exact: 0},
		handler(_args, context) {
			context.setMessages([]);
		},
	},

	{
		name: 'switch',
		description: 'Switch Orbit to work on a different project',
		usage: '/switch',
		argsRule: {exact: 0},
		handler(_args, context) {
			context.setSelectProjectMode(true);
			const options = context.constructProjectOptions();
			context.setProjectOptions(options);
		},
	},

	{
		name: 'test',
		description:
			'Generate and run a Playwright test for a feature you describe',
		usage: '/test <prompt>',
		argsRule: {min: 1},
		async handler(_args, context) {
			const prompt = _args.join(' ').trim();

			try {
				context.setIsThinking(true);
				const controller = context.startAbortableTask();
				await runTestCommand(prompt, context, controller.signal);
			} finally {
				context.setIsThinking(false);
				context.setAgentActivity(null);
				context.clearAbortableTask();
			}
		},
	},

	{
		name: 'abort',
		description: 'Aborting on going tasks',
		usage: '/abort',
		argsRule: {exact: 0},
		bypassBusyCheck: true,
		handler(_args, context) {
			const didAbort = context.abortCurrentTask();
			context.setMessages(previous => [
				...previous,
				{
					role: 'system',
					content: didAbort
						? 'Aborting current task...'
						: 'No running task to abort.',
					color: didAbort ? 'yellow' : 'red',
				},
			]);
		},
	},
	{
		name: 'scan',
		description: 'Scan the current project',
		usage: '/scan',
		argsRule: {exact: 0},
		async handler(_args, context) {
			if (!context.project?.root) {
				reportError(context.setMessages, {kind: 'no-project-selected'});
				return;
			}

			try {
				context.setIsThinking(true);

				const {projectMap, graphifyOutcome} = await scanProjectWithModeSelection(
					context.project.root,
					{
						requestApproval: context.requestApproval,
						requestScanMode: context.requestScanMode,
						setMessages: context.setMessages,
					},
				);
				const projectMapPath = writeProjectMap(
					context.project.root,
					projectMap,
				);

				const graphifyMessage = graphifyOutcomeMessage(graphifyOutcome);
				if (graphifyMessage) {
					context.setMessages(previous => [
						...previous,
						{role: 'agent', ...graphifyMessage},
					]);
				}

				context.setMessages(previous => [
					...previous,
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
		},
	},
	{
		name: 'config',
		description: 'View and change project configuration',
		usage: '/config',
		argsRule: {exact: 0},
		async handler(_args, context) {
			if (!context.project?.root) {
				reportError(context.setMessages, {kind: 'no-project-selected'});
				return;
			}

			const projectRoot = context.project.root;
			let orbitConfig = context.project.hasOrbitFolder
				? readOrbitConfig(projectRoot)
				: null;

			if (!orbitConfig) {
				reportError(context.setMessages, {kind: 'project-not-initialized'});
				return;
			}

			context.setMessages(previous => [
				...previous,
				{role: 'agent', content: formatConfigSummary(orbitConfig!)},
			]);

			// eslint-disable-next-line no-constant-condition
			while (true) {
				// Snapshotted once per iteration so the closures below (map,
				// setMessages) don't capture the `let`-reassigned outer
				// binding itself, only this iteration's fixed value.
				const configThisIteration = orbitConfig;
				const fieldOptions: Array<{label: string; value: string}> =
					CONFIG_FIELDS.map(field => ({
						label: `${field.label} (${formatConfigFieldValue(configThisIteration, field)})`,
						value: field.key,
					}));
				fieldOptions.push({label: 'Done', value: '__done__'});

				const chosenKey = await context.requestSelect(
					'Which setting do you want to change?',
					fieldOptions,
				);

				if (chosenKey === '__done__') {
					return;
				}

				const field = CONFIG_FIELDS.find(f => f.key === chosenKey);
				if (!field) continue;

				let nextConfig: OrbitConfig | null = null;

				if (field.kind === 'enum') {
					const picked = await context.requestSelect(
						`New value for ${field.label}:`,
						field.options.map(option => ({label: option, value: option})),
					);
					nextConfig = {...orbitConfig, [field.key]: picked};
				} else {
					const typed = await context.requestInput(
						field.kind === 'csv'
							? `New value for ${field.label} (comma-separated, e.g. "npm run dev, docker compose up"):`
							: `New value for ${field.label}:`,
					);

					if (typed === null) {
						continue;
					}

					if (field.kind === 'number') {
						const parsed = Number(typed);
						if (!Number.isInteger(parsed) || parsed <= 0) {
							context.setMessages(previous => [
								...previous,
								{
									role: 'agent',
									content: `"${typed}" isn't a valid positive integer — ${field.label} left unchanged.`,
									color: 'red',
								},
							]);
							continue;
						}

						nextConfig = {...orbitConfig, [field.key]: parsed};
					} else if (field.kind === 'csv') {
						const items = typed
							.split(',')
							.map(item => item.trim())
							.filter(Boolean);
						nextConfig = {...orbitConfig, [field.key]: items};
					} else {
						const trimmed = typed.trim();
						if (trimmed === '' && !field.nullable) {
							context.setMessages(previous => [
								...previous,
								{
									role: 'agent',
									content: `${field.label} can't be empty — left unchanged.`,
									color: 'red',
								},
							]);
							continue;
						}

						nextConfig = {
							...orbitConfig,
							[field.key]: trimmed === '' ? null : trimmed,
						};
					}
				}

				writeOrbitConfig(projectRoot, nextConfig);
				orbitConfig = nextConfig;
				const updatedConfig = nextConfig;

				context.setMessages(previous => [
					...previous,
					{
						role: 'agent',
						content: `${field.label} updated to ${formatConfigFieldValue(updatedConfig, field)}.`,
						color: 'green',
					},
				]);
			}
		},
	},
	{
		name: 'memory',
		description: 'Show project memory',
		usage: '/memory [--overview] [--decisions] [--env] [--failures]',
		argsRule: {min: 0},
		handler(_args, context) {
			if (!context.project?.root) {
				reportError(context.setMessages, {kind: 'no-project-selected'});
				return;
			}

			if (!context.project.hasOrbitFolder) {
				reportError(context.setMessages, {kind: 'project-not-initialized'});
				return;
			}

			const flagToSection: Record<string, keyof MemorySections> = {
				'--overview': 'overview',
				'--decisions': 'decisions',
				'--env': 'environment',
				'--failures': 'failures',
			};

			const unknownFlags = _args.filter(arg => !(arg in flagToSection));
			if (unknownFlags.length > 0) {
				context.setMessages(previous => [
					...previous,
					{
						role: 'system',
						content: `Unknown flag(s): ${unknownFlags.join(
							', ',
						)}. Valid flags: --overview, --decisions, --failures.`,
						color: 'red',
					},
				]);
				return;
			}

			// No flags at all -> show every section, same as before flags
			// existed. Any flags given -> show only what was asked for.
			const noFlags = _args.length === 0;
			const include: MemorySections = {
				overview: noFlags || _args.includes('--overview'),
				decisions: noFlags || _args.includes('--decisions'),
				environment: noFlags || _args.includes('--env'),
				failures: noFlags || _args.includes('--failures'),
			};

			const memory = readProjectMemory(context.project.root);

			context.setMessages(previous => [
				...previous,
				{role: 'agent', content: summarizeMemory(memory, include)},
			]);
		},
	},
	{
		name: 'coverage',
		description: "Show routes and components that don't have a matching test",
		usage: '/coverage',
		argsRule: {exact: 0},
		async handler(_args, context) {
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
				const scanResult = await scanProjectWithModeSelection(
					context.project.root,
					{
						requestApproval: context.requestApproval,
						requestScanMode: context.requestScanMode,
						setMessages: context.setMessages,
					},
				);
				projectMap = scanResult.projectMap;
				writeProjectMap(context.project.root, projectMap);

				const graphifyMessage = graphifyOutcomeMessage(scanResult.graphifyOutcome);
				if (graphifyMessage) {
					context.setMessages(previous => [
						...previous,
						{role: 'agent', ...graphifyMessage},
					]);
				}
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

			context.setMessages(previous => [
				...previous,
				{role: 'agent', content: formatCoverageSummary(report)},
				...(report.routes.length > 0
					? [
							{
								role: 'agent' as const,
								content: `Routes (${report.routes.length}):`,
							},
							...report.routes.map(entryMessage),
					  ]
					: []),
				...(report.components.length > 0
					? [
							{
								role: 'agent' as const,
								content: `Components (${report.components.length}):`,
							},
							...report.components.map(entryMessage),
					  ]
					: []),
			]);
		},
	},
	// This command will remove .orbit folder and its record in the global memory in projects.json
	// Rmb to make a user confirmation prompt
	{
		name: 'deinit',
		description: 'This command delete .orbit context for a particular project',
		usage: '/deinit',
		argsRule: {exact: 0},
		handler(_args, context) {
			const projectPath = getProjectPath(context.project);
			if (!projectPath.ok) {
				reportError(context.setMessages, {kind: 'no-project-selected'});
				return;
			}

			context.setConfirmDeinit(true);
		},
	},
];
