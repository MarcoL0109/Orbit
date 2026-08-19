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
import type {Message, ProjectOptions, ProjectInfo} from './commands/context.js';
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
} from './commands/commands.js';
import {generateRecommendedPrompt} from './ai/recommendPrompt.js';

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
	const [checkName, setCheckName] = useState<boolean>(false);
	const [confirmDeinit, setConfirmDeinit] = useState<boolean>(false);
	const [confirmName, setConfirmName] = useState<string>('');
	const [checkInitPath, setCheckInitPath] = useState<boolean>(false);
	const [confirmInitPath, setConfirmInitPath] = useState<string>('');
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

		if (item.value === 'add') {
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

		const commandContext = {
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
				project.hasOrbitFolder = false;
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
			<Box borderStyle="round" paddingX={1} flexDirection="column">
				<Box justifyContent="space-between">
					<Text bold>🪐 Orbit</Text>
					<Text color="cyan">Interactive Mode</Text>
				</Box>

				<Text>AI QA agent for E2E testing</Text>

				<Box marginTop={1} flexDirection="column">
					{isBooting && (
						<Text color="yellow">
							<Spinner type="dots" /> Detecting project context...
						</Text>
					)}

					{!isBooting && project?.isProject && (
						<>
							<Text>
								Project Path: <Text>{project.root}</Text>
							</Text>
							<Text>
								Confidence: <Text color="green">{project.confidence}%</Text>
							</Text>
							<Text>
								Stack:{' '}
								<Text color="green">
									{[
										project.framework,
										project.testFramework,
										project.packageManager,
									]
										.filter(Boolean)
										.join(' + ') || 'Unknown'}
								</Text>
							</Text>
							<Text>
								Orbit Context:{' '}
								<Text color={project.hasOrbitFolder ? 'green' : 'red'}>
									{project.hasOrbitFolder ? 'Initialized' : 'Not Initialized'}
								</Text>
							</Text>
						</>
					)}

					{!isBooting && !project?.isProject && (
						<>
							<Text color="red">No project detected</Text>
							<Text>
								Run Orbit inside a project or choose a recent project.
							</Text>
						</>
					)}

					{orbitConfig && (
						<>
							<Text>
								Approval mode:{' '}
								<Text
									color={
										orbitConfig.approvalMode === 'always' ? 'green' : 'yellow'
									}
								>
									{orbitConfig.approvalMode === 'always'
										? 'Always allow'
										: 'Ask before running'}
								</Text>
							</Text>
							<Text>
								Write mode:{' '}
								<Text
									color={
										orbitConfig.writeMode === 'always' ? 'green' : 'yellow'
									}
								>
									{orbitConfig.writeMode === 'always'
										? 'Always allow'
										: 'Ask before writing'}
								</Text>
							</Text>
							{CONFIG_FIELDS.filter(
								field =>
									field.key !== 'approvalMode' && field.key !== 'writeMode',
							).map(field => (
								<Text key={field.key}>
									{field.label}:{' '}
									<Text color="cyan">
										{formatConfigFieldValue(orbitConfig, field)}
									</Text>
								</Text>
							))}
							<Text>
								Test dir: <Text color="cyan">{orbitConfig.testDir}</Text>
							</Text>
							<Text>
								Manual test dir:{' '}
								<Text color="cyan">{orbitConfig.manualTestDir}</Text>
							</Text>
							<Text>
								Docker compose file:{' '}
								<Text color="cyan">
									{orbitConfig.dockerComposeFile ?? '(none)'}
								</Text>
							</Text>
							<Text>
								Docker compose healthchecks:{' '}
								<Text color="cyan">
									{orbitConfig.dockerComposeHasHealthchecks ? 'yes' : 'no'}
								</Text>
							</Text>
						</>
					)}
				</Box>
			</Box>

			<Box marginTop={1} flexDirection="column">
				{messages.map((message, index) => (
					<Text key={index} color={message.color || 'none'}>
						{message.role === 'user'
							? `You: ${message.content}`
							: message.role === 'agent'
							? `Orbit: ${message.content}`
							: message.content}
					</Text>
				))}
			</Box>

			{isBooting ||
			selectProjectMode ||
			confirmDeinit ||
			checkName ||
			checkInitPath ||
			isInitting ||
			pendingApproval ||
			pendingScanMode ||
			pendingOutcomeConfirmation ||
			pendingSelect ||
			pendingInput ? (
				<Box marginTop={1}>
					<Text color="yellow">
						<Spinner type="dots" /> Selection Menu In Progress...
					</Text>
				</Box>
			) : (
				<Box marginTop={1}>
					<Text color="cyan">{'> '}</Text>
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
				<Box flexDirection="column">
					<Text>Select an option (Use arrow keys and Enter):</Text>
					<SelectInput items={projectOptions} onSelect={handleProjectSelect} />
				</Box>
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

			{checkInitPath && (
				<Box marginTop={1} flexDirection="column">
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
				</Box>
			)}

			{isInitting && (
				<Text color="yellow">
					<Spinner type="dots" /> Initializing Orbit Context...
				</Text>
			)}

			{checkName && (
				<Box marginTop={1} flexDirection="column">
					<Text>The following name is detected. You can type in your own</Text>
					<TextInput
						value={confirmName}
						placeholder="Your Project Name"
						onChange={setConfirmName}
						onSubmit={handleConfirmNameInit}
					/>
				</Box>
			)}

			{isThinking && (
				<Text color="yellow">
					<Spinner type="dots" /> {agentActivity ?? "Orbit's thinking..."}
				</Text>
			)}

			{confirmDeinit && (
				<Box flexDirection="column">
					<Text color="red">
						Are you sure to deinit orbit context for this project. All context
						will be deleted after this
					</Text>
					<SelectInput
						items={confirmationOptions}
						onSelect={handleConfirmDeinit}
					/>
				</Box>
			)}

			{pendingApproval && (
				<Box flexDirection="column">
					<Text color="yellow">
						Orbit wants to: {pendingApproval.description}
					</Text>
					<SelectInput
						items={[
							{label: 'Approve', value: 'approve'},
							{label: 'Deny', value: 'deny'},
						]}
						onSelect={handleApprovalSelect}
					/>
				</Box>
			)}

			{pendingScanMode && (
				<Box flexDirection="column">
					<Text color="yellow">
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
				</Box>
			)}

			{pendingOutcomeConfirmation && (
				<Box flexDirection="column">
					<Text color="yellow">
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
				</Box>
			)}

			{pendingSelect && (
				<Box flexDirection="column">
					<Text color="yellow">{pendingSelect.prompt}</Text>
					<SelectInput
						items={pendingSelect.options}
						onSelect={handleSelectChoice}
					/>
				</Box>
			)}

			{pendingInput && (
				<Box flexDirection="column">
					<Text color="yellow">Orbit needs: {pendingInput.prompt}</Text>
					<Text dimColor>(Press Esc to decline)</Text>
					<TextInput
						value={pendingInputValue}
						placeholder="Type the value..."
						onChange={setPendingInputValue}
						onSubmit={handleInputSubmit}
					/>
				</Box>
			)}

			<Box marginTop={1}>
				<Text color="red">Type '/exit' to quit</Text>
			</Box>
		</Box>
	);
}
