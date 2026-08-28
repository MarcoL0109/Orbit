import React, {useEffect, useState, useRef} from 'react';
import {Box, Text, useInput} from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import SelectInput from 'ink-select-input';
import {
	detectProjectRoot,
	detectProjectAtPath,
	getProjectDisplayName,
} from './projects/search.js';
import {validateProjectPath} from './projects/path.js';
import {rememberProject, readGlobalProjects} from './registry/knownProjects.js';
import {initOrbitProject} from './init/init.js';
import type {InitFileAction} from './init/init.js';
import {deriveBlindProjectName} from './init/blindInit.js';
import {isReachable} from './projects/reachability.js';
import type {
	Message,
	ProjectOptions,
	ProjectInfo,
	CommandContext,
} from './commands/context.js';
import {runCommand} from './commands/runCommand.js';
import {
	getBestCommandCompletion,
	getGhostCompletion,
} from './commands/autocomplete.js';
import {formatScanResult, writeProjectMap} from './projects/scan.js';
import {
	scanProjectWithModeSelection,
	graphifyOutcomeMessage,
} from './projects/scanOrchestration.js';
import {
	ensurePlaywrightSetup,
	playwrightSetupOutcomeMessage,
} from './projects/playwrightSetup.js';
import {
	deinitLocalContext,
	getProjectPath,
	deinitGlobalContext,
} from './init/deinit.js';
import {reportError} from './commands/error.js';
import {readOrbitConfig} from './init/config.js';
import {
	CONFIG_FIELDS,
	formatConfigFieldValue,
	runAskFlow,
	startBlindProjectFlow,
} from './commands/commands.js';
import {generateRecommendedPrompt} from './ai/recommendPrompt.js';
import {theme} from './ui/theme.js';

// Every pendingX/checkX prompt below renders through this so a decision
// prompt looks the same regardless of which one is asking — border color is
// the only thing that varies, and it's chosen per call site to mean
// something (warning = an action Orbit wants to take, danger = a
// destructive one, accent = Orbit just needs information from you).
function PromptBox({
	borderColor,
	children,
}: {
	borderColor: string;
	children: React.ReactNode;
}) {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={borderColor}
			paddingX={1}
			marginTop={1}
		>
			{children}
		</Box>
	);
}

type AppProps = {
	readonly initialPrompt?: string;
};

export function App({initialPrompt}: AppProps) {
	const [messages, setMessages] = useState<Message[]>([]);
	const [query, setQuery] = useState<string>('');
	// Bumped whenever query is replaced programmatically (tab-completion)
	// rather than by the user typing — remounts the query TextInput so its
	// internal cursor offset re-initializes to the end of the new value.
	// ink-text-input only auto-adjusts the cursor when the value got
	// SHORTER than the cursor position; it never advances the cursor when
	// the value grows (e.g. "te" -> "test "), which is exactly what
	// completion does, so without this the cursor is left sitting wherever
	// it was in the middle of the completed word.
	const [queryInputKey, setQueryInputKey] = useState<number>(0);
	const [isBooting, setIsBooting] = useState<boolean>(true);
	const [isThinking, setIsThinking] = useState<boolean>(false);
	const [isInitting, setIsInitting] = useState<boolean>(false);
	const [project, setProject] = useState<ProjectInfo | null>(null);
	const [selectProjectMode, setSelectProjectMode] = useState<boolean>(false);
	const [projectOptions, setProjectOptions] = useState<ProjectOptions[]>([]);
	const [selectedProjectOption, setSelectedProjectOption] =
		useState<string>('');
	const [inputPath, setInputPath] = useState<string>('');
	const [inputBlindUrl, setInputBlindUrl] = useState<string>('');
	const [checkName, setCheckName] = useState<boolean>(false);
	const [confirmDeinit, setConfirmDeinit] = useState<boolean>(false);
	const [confirmName, setConfirmName] = useState<string>('');
	const [checkInitPath, setCheckInitPath] = useState<boolean>(false);
	const [confirmInitPath, setConfirmInitPath] = useState<string>('');
	const [checkBlindPath, setCheckBlindPath] = useState<boolean>(false);
	const [confirmBlindPath, setConfirmBlindPath] = useState<string>('');
	const [pendingBlindUrl, setPendingBlindUrl] = useState<string>('');
	const [pendingApproval, setPendingApproval] = useState<{
		description: string;
		resolve: (approved: boolean) => void;
	} | null>(null);
	const [pendingScanMode, setPendingScanMode] = useState<{
		resolve: (mode: 'regex' | 'graphify') => void;
	} | null>(null);
	const [pendingOutcomeConfirmation, setPendingOutcomeConfirmation] = useState<{
		feature: string;
		whatWasDone: string;
		output: string;
		resolve: (outcome: 'success' | 'failure') => void;
	} | null>(null);
	const [pendingInput, setPendingInput] = useState<{
		prompt: string;
		resolve: (value: string | null) => void;
	} | null>(null);
	const [pendingSelect, setPendingSelect] = useState<{
		prompt: string;
		options: Array<{label: string; value: string}>;
		resolve: (value: string) => void;
	} | null>(null);
	const [pendingInputValue, setPendingInputValue] = useState<string>('');
	const [agentActivity, setAgentActivity] = useState<string | null>(null);
	// Populated in the background by generateRecommendedPrompt — a real LLM
	// call, not a synchronous computation, so it can't just be derived
	// inline during render the way ghostCompletetion is. Refreshed after
	// boot and after every submitted prompt (command or ask), since either
	// can change what's worth suggesting next (a new test result, a fresh
	// scan). recommendedPromptRequestRef guards against an older, slower
	// call's result landing after a newer one already resolved.
	const [recommendedPrompt, setRecommendedPrompt] = useState<string | null>(
		null,
	);
	const currentAbortControllerRef = useRef<AbortController | null>(null);
	const readyEnvironmentsRef = useRef<Set<string>>(new Set());
	const recommendedPromptRequestRef = useRef<number>(0);
	// Mirrors `messages` for refreshRecommendedPrompt, which runs after an
	// awaited command/ask flow finishes — by then `messages` itself (a
	// value captured in that earlier closure) is stale, since every push
	// along the way used the functional setMessages(prev => ...) form. The
	// ref is kept current by the effect below on every render instead.
	const messagesRef = useRef<Message[]>([]);
	const ghostCompletetion = getGhostCompletion(query);
	const confirmationOptions = [
		{label: 'Confirm', value: 'confirm'},
		{label: 'Cancel', value: 'cancel'},
	];

	function isEnvironmentReady(projectRoot: string): boolean {
		return readyEnvironmentsRef.current.has(projectRoot);
	}

	function markEnvironmentReady(projectRoot: string): void {
		readyEnvironmentsRef.current.add(projectRoot);
	}

	function refreshRecommendedPrompt(projectRoot: string): void {
		const requestId = recommendedPromptRequestRef.current + 1;
		recommendedPromptRequestRef.current = requestId;

		generateRecommendedPrompt(projectRoot, messagesRef.current)
			.then(prompt => {
				if (recommendedPromptRequestRef.current === requestId) {
					setRecommendedPrompt(prompt);
				}
			})
			.catch(() => {
				if (recommendedPromptRequestRef.current === requestId) {
					setRecommendedPrompt(null);
				}
			});
	}

	useInput((_input, key) => {
		if (key.tab) {
			const completion = getBestCommandCompletion(query);

			if (completion) {
				setQuery(completion);
				setQueryInputKey(previous => previous + 1);
			} else if (query === '' && recommendedPrompt) {
				setQuery(recommendedPrompt);
				setQueryInputKey(previous => previous + 1);
			}
		}

		if (key.escape && pendingInput) {
			pendingInput.resolve(null);
			setPendingInput(null);
			setPendingInputValue('');
		}
	});

	useEffect(() => {
		messagesRef.current = messages;
	}, [messages]);

	useEffect(() => {
		async function bootOrbit() {
			setIsBooting(true);

			const detectedProject = detectProjectRoot();

			setProject(detectedProject);

			if (detectedProject.isProject && detectedProject.root) {
				setSelectProjectMode(false);
				setMessages([
					{
						role: 'system',
						content: `Project detected: ${detectedProject.root}`,
					},
				]);
				refreshRecommendedPrompt(detectedProject.root);
			} else {
				const options = constructProjectOptions();
				setProjectOptions(options);
				setSelectProjectMode(true);
				setMessages([
					{
						role: 'system',
						content:
							'No project detected in this directory. You can still ask Orbit to choose a recent project later.',
					},
				]);
			}

			setIsBooting(false);
		}

		bootOrbit();
	}, []);

	function startAbortableTask() {
		const controller = new AbortController();
		currentAbortControllerRef.current = controller;
		return controller;
	}

	function clearAbortableTask() {
		currentAbortControllerRef.current = null;
	}

	async function requestApproval(description: string): Promise<boolean> {
		return new Promise(resolve => {
			setPendingApproval({description, resolve});
		});
	}

	function handleApprovalSelect(item: any) {
		pendingApproval?.resolve(item.value === 'approve');
		setPendingApproval(null);
	}

	async function requestScanMode(): Promise<'regex' | 'graphify'> {
		return new Promise(resolve => {
			setPendingScanMode({resolve});
		});
	}

	function handleScanModeSelect(item: any) {
		pendingScanMode?.resolve(item.value);
		setPendingScanMode(null);
	}

	async function requestOutcomeConfirmation(
		feature: string,
		whatWasDone: string,
		output: string,
	): Promise<'success' | 'failure'> {
		return new Promise(resolve => {
			setPendingOutcomeConfirmation({feature, whatWasDone, output, resolve});
		});
	}

	function handleOutcomeConfirmationSelect(item: any) {
		pendingOutcomeConfirmation?.resolve(item.value);
		setPendingOutcomeConfirmation(null);
	}

	async function requestSelect(
		prompt: string,
		options: Array<{label: string; value: string}>,
	): Promise<string> {
		return new Promise(resolve => {
			setPendingSelect({prompt, options, resolve});
		});
	}

	function handleSelectChoice(item: any) {
		pendingSelect?.resolve(item.value);
		setPendingSelect(null);
	}

	async function requestInput(prompt: string): Promise<string | null> {
		return new Promise(resolve => {
			setPendingInput({prompt, resolve});
		});
	}

	function handleInputSubmit(value: string) {
		pendingInput?.resolve(value.trim() || null);
		setPendingInput(null);
		setPendingInputValue('');
	}

	function abortCurrentTask() {
		if (!currentAbortControllerRef.current) {
			return false;
		}

		currentAbortControllerRef.current.abort();
		currentAbortControllerRef.current = null;
		setIsThinking(false);
		setIsInitting(false);
		setAgentActivity(null);
		return true;
	}

	const handleProjectSelect = (item: any) => {
		// Branch on item.value directly, not the selectedProjectOption state —
		// setSelectedProjectOption below doesn't take effect until the next
		// render, so reading the state here would only ever see the PREVIOUS
		// selection, not this one.
		if (item.value === 'exit') {
			process.exit(0);
		}

		if (item.value === 'quit') {
			setSelectProjectMode(false);
			setSelectedProjectOption('');
			return;
		}

		if (item.value === 'add' || item.value === 'blind') {
			setSelectedProjectOption(item.value);
			return;
		}

		// Otherwise item.value is the name of an already-tracked project.
		const matched = readGlobalProjects().projects.find(
			knownProject => knownProject.name === item.value,
		);

		if (!matched) {
			setMessages(previous => [
				...previous,
				{
					role: 'system',
					content: `Could not find a tracked project named "${item.value}".`,
					color: 'red',
				},
			]);
			setSelectProjectMode(false);
			setSelectedProjectOption('');
			return;
		}

		const detected = detectProjectRoot(matched.path);
		setProject(detected);

		if (detected.isProject) {
			rememberProject({
				name: matched.name,
				path: matched.path,
				framework: matched.framework,
				packageManager: matched.packageManager,
				testFramework: matched.testFramework,
				description: matched.description,
				primaryFeatures: matched.primaryFeatures,
				lastScannedAt: matched.lastScannedAt,
			});
		}

		setMessages(previous => [
			...previous,
			{
				role: 'system',
				content: detected.isProject
					? `Switched to project: ${detected.root}`
					: `"${matched.name}" (${matched.path}) no longer looks like a valid project.`,
				color: detected.isProject ? 'green' : 'red',
			},
		]);
		setSelectProjectMode(false);
		setSelectedProjectOption('');
	};

	const constructProjectOptions = () => {
		const projectJsonList = readGlobalProjects();
		const options = projectJsonList.projects.map(project => ({
			label: `->${project.name}`,
			value: project.name,
		}));
		options.push({
			label: '-> Add New Project',
			value: 'add',
		});
		options.push({
			label: '-> Set Up Blind Project (URL only, no local source)',
			value: 'blind',
		});
		if (project) {
			options.push({
				label: '-> Exit Menu',
				value: 'quit',
			});
		}

		options.push({
			label: '-> Quit Orbit',
			value: 'exit',
		});
		return options;
	};

	function formatInitResult(files: InitFileAction[]) {
		const created = files.filter(file => file.action === 'created');
		const skipped = files.filter(file => file.action === 'skipped');
		const createdText =
			created.length > 0
				? created.map(file => `✓ ${file.relativePath}`).join('\n')
				: 'None';
		const skippedText =
			skipped.length > 0
				? skipped.map(file => `✗ ${file.relativePath}`).join('\n')
				: 'None';

		return `Orbit initialized this project.

Created:
${createdText}
Skipped:
${skippedText}

Tip: if this project's dev environment needs a specific startup sequence, describe it in .orbit/memory/environment_setup.md and Orbit will follow it directly. Leave it empty and Orbit will work it out itself the first time — and write down what it learned there for next time.
`;
	}

	// Built once, called from anywhere that needs to dispatch a command —
	// handleSubmitQuery (typed input) and handleBlindUrlSubmit (the
	// project-picker's "Set Up Blind Project" option) both need the exact
	// same context, and this is the one place its ~25 fields are listed.
	function buildCommandContext(): CommandContext {
		return {
			setMessages,
			setQuery,
			setIsThinking,
			setSelectProjectMode,
			setProjectOptions,
			setIsInitting,
			project,
			isThinking,
			constructProjectOptions,
			setProject,
			setCheckName,
			setConfirmName,
			setCheckInitPath,
			setConfirmInitPath,
			setCheckBlindPath,
			setConfirmBlindPath,
			setPendingBlindUrl,
			startAbortableTask,
			clearAbortableTask,
			abortCurrentTask,
			setConfirmDeinit,
			requestApproval,
			requestInput,
			requestScanMode,
			requestOutcomeConfirmation,
			requestSelect,
			setAgentActivity,
			isEnvironmentReady,
			markEnvironmentReady,
		};
	}

	const handleSubmitQuery = async (value: string) => {
		const prompt = value.trim();

		if (!prompt) return;
		setQuery('');

		setMessages(previous => [
			...previous,
			{
				role: 'user',
				content: prompt,
			},
		]);

		const commandContext = buildCommandContext();

		const commandHandled = await runCommand(prompt, commandContext);

		if (commandHandled) {
			if (project?.root) refreshRecommendedPrompt(project.root);
			return;
		}

		if (isThinking) {
			setMessages(previous => [
				...previous,
				{
					role: 'agent',
					content:
						'There is ongoing task Orbit is handling. You can use the /abort command to terminate previous task',
					color: 'red',
				},
			]);
			return;
		}

		await runAskFlow(prompt, commandContext);

		if (project?.root) refreshRecommendedPrompt(project.root);
	};

	const handleProjectPath = () => {
		setMessages(previous => [
			...previous,
			{
				role: 'system',
				content: `Received Project Path: ${inputPath}`,
			},
		]);
		const res = validateProjectPath(inputPath);
		if (!res.ok) {
			setMessages(previous => [
				...previous,
				{
					role: 'system',
					content: `Project path ${res.path} does not exist`,
				},
			]);
		} else {
			// Trusted directly, same as /init <path> — the user just typed this
			// exact directory in, so there's no reason to run it back through
			// detectProjectRoot's confidence threshold (that exists for
			// *guessing* a root from an arbitrary cwd, not for a path someone
			// named themselves). validateProjectPath above already confirmed
			// it exists and is a directory, so detectProjectAtPath is
			// guaranteed isProject here.
			const checkProject = detectProjectAtPath(res.path);
			setProject(checkProject);
			setMessages(previous => [
				...previous,
				{
					role: 'system',
					content: `Switched to project: ${checkProject.root}`,
				},
			]);
		}

		setSelectProjectMode(false);
		setInputPath('');
		setSelectedProjectOption('');
	};

	// Reuses startBlindProjectFlow (validation, known-URL lookup, the
	// storage-path confirm prompt) rather than reimplementing any of it —
	// the same shared flow /config's "Blind mode" field triggers too, just
	// reached here for the case where no project is active yet, so the
	// free-text input bar isn't available (selectProjectMode is showing
	// this picker instead).
	const handleBlindUrlSubmit = async (value: string) => {
		const url = value.trim();
		setSelectProjectMode(false);
		setSelectedProjectOption('');
		setInputBlindUrl('');

		if (!url) return;

		setMessages(previous => [
			...previous,
			{role: 'user', content: `Set up blind project: ${url}`},
		]);

		await startBlindProjectFlow(url, buildCommandContext());
	};

	const handleConfirmInitPath = () => {
		// Unmount this TextInput before anything else, same reasoning as
		// handleConfirmNameInit below — it must not still be listening once
		// the name-confirmation TextInput mounts right after it.
		setCheckInitPath(false);
		const submittedPath = confirmInitPath;
		setConfirmInitPath('');

		// The user has now explicitly approved this exact path (whether by
		// editing it or accepting the suggestion as-is), so — same as
		// /init <path> — detectProjectAtPath trusts it directly rather than
		// re-running it through detectProjectRoot's confidence threshold.
		const detected = detectProjectAtPath(submittedPath);

		if (!detected.isProject || !detected.root) {
			reportError(setMessages, {
				kind: 'invalid-project-path',
				path: submittedPath,
			});
			return;
		}

		if (detected.hasOrbitFolder) {
			reportError(setMessages, {kind: 'project-already-initialized'});
			return;
		}

		setProject(detected);
		setConfirmName(getProjectDisplayName(detected.root));
		setCheckName(true);
	};

	// No separate name-confirmation step here, unlike normal /init — the
	// derived name (from the URL's hostname) is only ever used as a
	// registry label, never shown as "your project" the way a real
	// codebase's name is, so there's nothing worth pausing to confirm twice.
	const handleConfirmBlindPath = async () => {
		setCheckBlindPath(false);
		const storageRoot = confirmBlindPath;
		const targetUrl = pendingBlindUrl;
		setConfirmBlindPath('');
		setPendingBlindUrl('');

		const projectName = deriveBlindProjectName(targetUrl);

		setIsInitting(true);

		try {
			// Re-checked here, not just trusted from startBlindProjectFlow's
			// earlier check at URL-entry time — the user may have taken a
			// while confirming (or editing) the storage path, and the site
			// could have gone down in the meantime. Nothing gets created
			// until this exact moment passes too, so a workspace is never
			// left behind for a target that turned out unreachable.
			const reachable = await isReachable(targetUrl);
			if (!reachable) {
				reportError(setMessages, {
					kind: 'blind-target-unreachable',
					baseUrl: targetUrl,
				});
				return;
			}

			initOrbitProject({
				projectRoot: storageRoot,
				projectName,
				blind: {targetUrl},
			});

			rememberProject({
				name: projectName,
				path: storageRoot,
				blind: true,
				targetUrl,
			});

			setProject({
				isProject: true,
				root: storageRoot,
				confidence: 100,
				markers: [],
				hasOrbitFolder: true,
				blind: true,
				targetUrl,
			});

			// storageRoot is a fresh directory Orbit just created — never the
			// target's own node_modules (there is no target codebase in blind
			// mode) — so Playwright has to be installed here specifically, not
			// inherited from anywhere. npm installs fine into a directory with
			// no package.json yet; it creates a minimal one itself.
			let playwrightMessage: {content: string; color: string} | null = null;
			try {
				const playwrightOutcome = await ensurePlaywrightSetup(storageRoot, {
					requestApproval,
				});
				playwrightMessage = playwrightSetupOutcomeMessage(playwrightOutcome);
			} catch (error) {
				reportError(setMessages, {
					kind: 'unexpected',
					action: 'Installing Playwright for the blind project',
					cause: error,
				});
			}

			setMessages(previous => [
				...previous,
				{
					role: 'agent',
					content: `Blind project set up: ${projectName}
Storage: ${storageRoot}
Target: ${targetUrl}
${playwrightMessage ? `\n${playwrightMessage.content}\n` : ''}
Orbit will explore this app purely through a live browser — nothing outside ${storageRoot} is ever read or written.`,
					color: 'green',
				},
			]);
		} catch (error) {
			reportError(setMessages, {
				kind: 'unexpected',
				action: 'Setting up the blind project',
				cause: error,
			});
		} finally {
			setIsInitting(false);
		}
	};

	const handleConfirmNameInit = async () => {
		if (!project) return;

		// Unmount the "confirm your project name" TextInput immediately,
		// before any of the async init/scan work below starts — it must
		// not still be mounted (and listening for Enter) once the
		// scan-mode SelectInput renders later in this same flow, or a
		// keypress meant for that select can also re-trigger this
		// TextInput's onSubmit, firing this whole function a second time
		// (confirmed: this is exactly what caused the scan-mode prompt to
		// be asked twice in one /init run).
		setCheckName(false);
		setConfirmName('');

		setIsInitting(true);

		let initSucceeded = false;
		let initResultFiles: InitFileAction[] = [];

		try {
			const result = initOrbitProject({
				projectName: confirmName,
				projectRoot: project.root || '',
				framework: project.framework,
				packageManager: project.packageManager,
				testFramework: project.testFramework,
			});
			initResultFiles = result.files;

			rememberProject({
				name: confirmName,
				path: project.root || '',
				framework: project.framework ?? null,
				packageManager: project.packageManager ?? null,
				testFramework: project.testFramework ?? null,
				lastScannedAt: null,
			});

			setProject?.(previous =>
				previous
					? {
							...previous,
							hasOrbitFolder: true,
					  }
					: previous,
			);
			initSucceeded = true;
		} catch (error) {
			reportError(setMessages, {
				kind: 'unexpected',
				action: 'Initializing Orbit context',
				cause: error,
			});
		}

		if (initSucceeded) {
			// The scan (and its graphify sub-step) runs BEFORE the init
			// success message is sent, specifically so graphify's own
			// build/update summary — when graphify runs — can be folded
			// directly into that one message instead of trailing in as an
			// unrelated-looking separate line. Kept as its own try/catch:
			// init already succeeded and .orbit already exists at this
			// point, so a scan failure here is a different problem from an
			// init failure — the init message still gets sent below either
			// way, just without a graphify line to fold in.
			let graphifyMessage: {content: string; color: string} | null = null;

			if (project.root) {
				try {
					const {projectMap, graphifyOutcome} =
						await scanProjectWithModeSelection(project.root, {
							requestApproval,
							requestScanMode,
							setMessages,
						});
					const projectMapPath = writeProjectMap(project.root, projectMap);
					graphifyMessage = graphifyOutcomeMessage(graphifyOutcome);

					const playwrightOutcome = await ensurePlaywrightSetup(project.root, {
						requestApproval,
					});
					const playwrightMessage =
						playwrightSetupOutcomeMessage(playwrightOutcome);

					setMessages(previous => [
						...previous,
						{
							role: 'agent',
							content: `${formatInitResult(initResultFiles)}${
								graphifyMessage ? `\n${graphifyMessage.content}\n` : ''
							}${playwrightMessage ? `\n${playwrightMessage.content}\n` : ''}
Global memory updated:
✓ ~/.orbit/projects.json`,
							color: 'green',
						},
						{
							role: 'agent',
							content: formatScanResult(projectMap, projectMapPath),
							color: 'green',
						},
					]);
				} catch (error) {
					setMessages(previous => [
						...previous,
						{
							role: 'agent',
							content: `${formatInitResult(initResultFiles)}
Global memory updated:
✓ ~/.orbit/projects.json`,
							color: 'green',
						},
					]);
					reportError(setMessages, {
						kind: 'post-init-scan-failed',
						cause: error,
					});
				}
			} else {
				setMessages(previous => [
					...previous,
					{
						role: 'agent',
						content: `${formatInitResult(initResultFiles)}
Global memory updated:
✓ ~/.orbit/projects.json`,
						color: 'green',
					},
				]);
			}
		}

		setIsInitting(false);
	};

	const handleConfirmDeinit = (item: any) => {
		if (item.value === 'confirm') {
			setIsThinking(true);
			if (project) {
				const projectPath = getProjectPath(project);
				if (!projectPath.ok) {
					reportError(setMessages, {kind: 'no-project-selected'});
					setIsThinking(false);
					setConfirmDeinit(false);
					return;
				}

				const path = projectPath.route;
				deinitLocalContext(path);
				setMessages(previous => [
					...previous,
					{
						role: 'system',
						content: `Orbit context of ${path} deleted successfully`,
						color: 'green',
					},
				]);
				if (project.root) {
					const deinitGlobalRepsonse = deinitGlobalContext(project.root);
					if (deinitGlobalRepsonse.ok) {
						setMessages(previous => [
							...previous,
							{
								role: 'system',
								content: `Removed project from global orbit memory`,
								color: 'green',
							},
						]);
					}
				}

				// Reset to a clean "no project" state rather than mutating
				// the old object in place — the local orbit/.orbit folder
				// is gone now, so hasOrbitFolder, blind, targetUrl, and
				// everything else about the old project are all stale.
				// Leaving any of it behind is exactly what left a deinit'd
				// blind project stuck still showing itself as blind.
				setProject(null);
			}
		}

		setIsThinking(false);
		setConfirmDeinit(false);
	};

	// Read fresh on every render rather than cached in state — matches how
	// every command handler already treats config.json (see commands.ts),
	// and keeps the header in sync immediately after /config edits it.
	const orbitConfig =
		project?.hasOrbitFolder && project.root
			? readOrbitConfig(project.root)
			: null;

	return (
		<Box flexDirection="column">
			<Box
				borderStyle="round"
				borderColor={theme.accent}
				paddingX={1}
				flexDirection="column"
			>
				<Box justifyContent="space-between">
					<Text bold color={theme.accent}>
						🪐 Orbit
					</Text>
					<Text color={theme.accent}>
						{project?.blind ? '⊘ Blind' : '⊙ Interactive'}
					</Text>
				</Box>

				<Text dimColor>AI QA agent for E2E testing</Text>

				<Box marginTop={2} flexDirection="column">
					{isBooting && (
						<Text color={theme.warning}>
							<Spinner type="dots" /> Detecting project context...
						</Text>
					)}

					{!isBooting && project?.isProject && project.blind && (
						<Box flexDirection="column" marginTop={1}>
							<Text dimColor bold>
								PROJECT
							</Text>
							<Box>
								<Box width={24}>
									<Text dimColor>Mode</Text>
								</Box>
								<Text color={theme.accent}>⊘ Blind — no local source</Text>
							</Box>
							<Box>
								<Box width={24}>
									<Text dimColor>Target</Text>
								</Box>
								<Text>{project.targetUrl}</Text>
							</Box>
							<Box>
								<Box width={24}>
									<Text dimColor>Storage</Text>
								</Box>
								<Text>{project.root}</Text>
							</Box>
						</Box>
					)}

					{!isBooting && project?.isProject && !project.blind && (
						<Box flexDirection="column" marginTop={1}>
							<Text dimColor bold>
								PROJECT
							</Text>
							<Box>
								<Box width={24}>
									<Text dimColor>Path</Text>
								</Box>
								<Text>{project.root}</Text>
							</Box>
							<Box>
								<Box width={24}>
									<Text dimColor>Confidence</Text>
								</Box>
								<Text color={theme.success}>{project.confidence}%</Text>
							</Box>
							<Box>
								<Box width={24}>
									<Text dimColor>Stack</Text>
								</Box>
								<Text>
									{[
										project.framework,
										project.testFramework,
										project.packageManager,
									]
										.filter(Boolean)
										.join(' · ') || 'Unknown'}
								</Text>
							</Box>
							<Box>
								<Box width={24}>
									<Text dimColor>Context</Text>
								</Box>
								<Text
									color={project.hasOrbitFolder ? theme.success : theme.danger}
								>
									{project.hasOrbitFolder ? 'Initialized' : 'Not initialized'}
								</Text>
							</Box>
						</Box>
					)}

					{!isBooting && !project?.isProject && (
						<Box flexDirection="column" marginTop={1}>
							<Text color={theme.danger} bold>
								No project detected
							</Text>
							<Text dimColor>
								Run Orbit inside a project or choose a recent project.
							</Text>
						</Box>
					)}

					{orbitConfig && (
						<Box flexDirection="column" marginTop={1}>
							<Text dimColor bold>
								CONFIG
							</Text>
							<Box>
								<Box width={24}>
									<Text dimColor>Approval</Text>
								</Box>
								<Text
									color={
										orbitConfig.approvalMode === 'always'
											? theme.success
											: theme.warning
									}
								>
									{orbitConfig.approvalMode === 'always'
										? 'Always allow'
										: 'Ask before running'}
								</Text>
							</Box>
							<Box>
								<Box width={24}>
									<Text dimColor>Write</Text>
								</Box>
								<Text
									color={
										orbitConfig.writeMode === 'always'
											? theme.success
											: theme.warning
									}
								>
									{orbitConfig.writeMode === 'always'
										? 'Always allow'
										: 'Ask before writing'}
								</Text>
							</Box>
							{CONFIG_FIELDS.filter(
								field =>
									field.key !== 'approvalMode' && field.key !== 'writeMode',
							).map(field => (
								<Box key={field.key}>
									<Box width={24}>
										<Text dimColor>{field.label}</Text>
									</Box>
									<Text>{formatConfigFieldValue(orbitConfig, field)}</Text>
								</Box>
							))}
							<Box>
								<Box width={24}>
									<Text dimColor>Test dir</Text>
								</Box>
								<Text>{orbitConfig.testDir}</Text>
							</Box>
							<Box>
								<Box width={24}>
									<Text dimColor>Manual dir</Text>
								</Box>
								<Text>{orbitConfig.manualTestDir}</Text>
							</Box>
							<Box>
								<Box width={24}>
									<Text dimColor>Docker</Text>
								</Box>
								<Text>
									{orbitConfig.dockerComposeFile ?? '(none)'}
									{orbitConfig.dockerComposeFile
										? ` — healthchecks: ${
												orbitConfig.dockerComposeHasHealthchecks ? 'yes' : 'no'
										  }`
										: ''}
								</Text>
							</Box>
						</Box>
					)}
				</Box>
			</Box>

			<Box marginTop={1} flexDirection="column">
				{messages.map((message, index) => {
					const tag =
						message.role === 'user'
							? '[you] '
							: message.role === 'agent'
							? '[orbit] '
							: null;
					const tagColor = message.role === 'user' ? theme.user : theme.accent;

					return (
						<Box key={index} marginTop={index === 0 ? 0 : 1}>
							<Text color={message.color} dimColor={message.dim}>
								{tag && (
									<Text
										bold
										color={
											message.color ?? (message.dim ? undefined : tagColor)
										}
									>
										{tag}
									</Text>
								)}
								{message.content}
							</Text>
						</Box>
					);
				})}
			</Box>

			{!(
				isBooting ||
				selectProjectMode ||
				confirmDeinit ||
				checkName ||
				checkInitPath ||
				checkBlindPath ||
				isInitting ||
				pendingApproval ||
				pendingScanMode ||
				pendingOutcomeConfirmation ||
				pendingSelect ||
				pendingInput
			) && (
				<Box marginTop={1}>
					<Text color={theme.user}>{'❯ '}</Text>
					<TextInput
						key={queryInputKey}
						value={query}
						placeholder={
							isThinking
								? '/abort to terminate the current task'
								: recommendedPrompt ?? 'Ask Orbit to test something'
						}
						onChange={setQuery}
						onSubmit={handleSubmitQuery}
					/>
					{ghostCompletetion && <Text dimColor>{ghostCompletetion}</Text>}
				</Box>
			)}

			{selectProjectMode && (
				<PromptBox borderColor={theme.accent}>
					<Text>Select an option (Use arrow keys and Enter):</Text>
					<SelectInput items={projectOptions} onSelect={handleProjectSelect} />
				</PromptBox>
			)}

			{selectedProjectOption === 'add' && (
				<Box marginTop={1}>
					<TextInput
						value={inputPath}
						placeholder="Type Project Path (FROM HOME)"
						onChange={setInputPath}
						onSubmit={handleProjectPath}
					/>
				</Box>
			)}

			{selectedProjectOption === 'blind' && (
				<Box marginTop={1}>
					<TextInput
						value={inputBlindUrl}
						placeholder="Paste the app's URL (https://...)"
						onChange={setInputBlindUrl}
						onSubmit={handleBlindUrlSubmit}
					/>
				</Box>
			)}

			{checkInitPath && (
				<PromptBox borderColor={theme.accent}>
					<Text>
						Detected project path shown below. Press Enter to use it, or edit it
						first.
					</Text>
					<TextInput
						value={confirmInitPath}
						placeholder="Project path"
						onChange={setConfirmInitPath}
						onSubmit={handleConfirmInitPath}
					/>
				</PromptBox>
			)}

			{checkBlindPath && (
				<PromptBox borderColor={theme.accent}>
					<Text>
						Blind mode — no local codebase is read or written. Where should
						Orbit store its own files for {pendingBlindUrl}? Press Enter to use
						this path, or edit it first.
					</Text>
					<TextInput
						value={confirmBlindPath}
						placeholder="Storage path"
						onChange={setConfirmBlindPath}
						onSubmit={handleConfirmBlindPath}
					/>
				</PromptBox>
			)}

			{isInitting && (
				<Text color={theme.warning}>
					<Spinner type="dots" /> Initializing Orbit Context...
				</Text>
			)}

			{checkName && (
				<PromptBox borderColor={theme.accent}>
					<Text>The following name is detected. You can type in your own</Text>
					<TextInput
						value={confirmName}
						placeholder="Your Project Name"
						onChange={setConfirmName}
						onSubmit={handleConfirmNameInit}
					/>
				</PromptBox>
			)}

			{isThinking && (
				<Text color={theme.warning}>
					<Spinner type="dots" /> {agentActivity ?? "Orbit's thinking..."}
				</Text>
			)}

			{confirmDeinit && (
				<PromptBox borderColor={theme.danger}>
					<Text color={theme.danger}>
						Are you sure to deinit orbit context for this project. All context
						will be deleted after this
					</Text>
					<SelectInput
						items={confirmationOptions}
						onSelect={handleConfirmDeinit}
					/>
				</PromptBox>
			)}

			{pendingApproval && (
				<PromptBox borderColor={theme.warning}>
					<Text color={theme.warning}>
						⚠ Orbit wants to: {pendingApproval.description}
					</Text>
					<SelectInput
						items={[
							{label: 'Approve', value: 'approve'},
							{label: 'Deny', value: 'deny'},
						]}
						onSelect={handleApprovalSelect}
					/>
				</PromptBox>
			)}

			{pendingScanMode && (
				<PromptBox borderColor={theme.accent}>
					<Text color={theme.accent}>
						How should Orbit understand this project's code?
					</Text>
					<SelectInput
						items={[
							{
								label: 'Regex — built-in heuristic scan, always available',
								value: 'regex',
							},
							{
								label:
									'Graphify — deeper AST-based knowledge graph, needs a separate install',
								value: 'graphify',
							},
						]}
						onSelect={handleScanModeSelect}
					/>
				</PromptBox>
			)}

			{pendingOutcomeConfirmation && (
				<PromptBox borderColor={theme.accent}>
					<Text color={theme.accent}>
						Orbit isn't sure whether this is a success or a failure — feature:{' '}
						{pendingOutcomeConfirmation.feature}
					</Text>
					<Text bold>What it did:</Text>
					<Text>{pendingOutcomeConfirmation.whatWasDone}</Text>
					<Text bold>What happened:</Text>
					<Text>{pendingOutcomeConfirmation.output}</Text>
					<SelectInput
						items={[
							{label: 'Success', value: 'success'},
							{label: 'Failure', value: 'failure'},
						]}
						onSelect={handleOutcomeConfirmationSelect}
					/>
				</PromptBox>
			)}

			{pendingSelect && (
				<PromptBox borderColor={theme.accent}>
					<Text color={theme.accent}>{pendingSelect.prompt}</Text>
					<SelectInput
						items={pendingSelect.options}
						onSelect={handleSelectChoice}
					/>
				</PromptBox>
			)}

			{pendingInput && (
				<PromptBox borderColor={theme.accent}>
					<Text color={theme.accent}>Orbit needs: {pendingInput.prompt}</Text>
					<Text dimColor>(Press Esc to decline)</Text>
					<TextInput
						value={pendingInputValue}
						placeholder="Type the value..."
						onChange={setPendingInputValue}
						onSubmit={handleInputSubmit}
					/>
				</PromptBox>
			)}

			<Box marginTop={1}>
				<Text dimColor>/help for instructions</Text>
			</Box>
		</Box>
	);
}
