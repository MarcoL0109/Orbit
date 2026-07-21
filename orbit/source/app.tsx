import React, { useEffect, useState, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { detectProjectRoot } from './projects/search.js';
import { validateProjectPath } from './projects/path.js';
import SelectInput from 'ink-select-input';
import { rememberProject } from "./init/initMark.js";
import { initOrbitProject } from "./init/init.js";
import type { InitFileAction } from './init/init.js';
import type { Message, ProjectOptions, ProjectInfo } from './commands/context.js'
import { runCommand } from './commands/rumCommand.js';
import { getBestCommandCompletion, getGhostCompletion } from './commands/autocomplete.js';
import { formatScanResult } from "./commands/commands.js";
import { readGlobalProjects } from './projects/readProjectMem.js';
import { scanProject, writeProjectMap } from './projects/scan.js';
import { deinitContext, getProjectPath } from './init/deinit.js';



type AppProps = {
	initialPrompt?: string;
}


export function App({ initialPrompt }: AppProps) {
	const [messages, setMessages] = useState<Message[]>([]);
	const [query, setQuery] = useState<string>("");
	const [isBooting, setIsBooting] = useState<boolean>(true);
	const [isThinking, setIsThinking] = useState<boolean>(false);
	const [isInitting, setIsInitting] = useState<boolean>(false);
	const [reInit, setReInit] = useState<boolean>(false);
	const [project, setProject] = useState<ProjectInfo | null>(null);
	const [selectProjectMode, setSelectProjectMode] = useState<boolean>(false);
	const [projectOptions, setProjectOptions] = useState<ProjectOptions[]>([]);
	const [selectedProjectOption, setSelectedProjectOption] = useState<string>("");
	const [inputPath, setInputPath] = useState<string>("");
	const [checkName, setCheckName] = useState<boolean>(false);
	const [confirmDeinit, setConfirmDeinit] = useState<boolean>(false);
	const [confirmName, setConfirmName] = useState<string>("");
	const currentAbortControllerRef = useRef<AbortController | null>(null);
	const ghostCompletetion = getGhostCompletion(query);
	const confirmationOptions = [{label: "Confirm", value: "confirm"}, {label: "Cancel", value: "cancel"}]


	useInput((_input, key) => {
		if (key.tab) {
		const completion = getBestCommandCompletion(query);

		if (completion) {
			setQuery(completion + ' ');
		}
		}
	});


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


	function abortCurrentTask() {
		if (!currentAbortControllerRef.current) {
			return false;
		}
		currentAbortControllerRef.current.abort();
		currentAbortControllerRef.current = null;
		setIsThinking(false);
		setIsInitting(false);
		return true;
	}


	const handleProjectSelect = (item: any) => {
		setSelectedProjectOption(item.value);
		if (selectedProjectOption === 'exit') {
			process.exit(0);
		}
		if (selectedProjectOption === 'quit') {
			setSelectProjectMode(false);
		}
	}

	
	const constructProjectOptions = () => {
		const projectJsonList = readGlobalProjects();
		const options = projectJsonList.projects.map((project) => ({
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
		const created = files.filter((file) => file.action === 'created');
		const skipped = files.filter((file) => file.action === 'skipped');
		const createdText =
		created.length > 0
			? created.map((file) => `✓ ${file.relativePath}`).join('\n')
			: 'None';
		const skippedText =
		skipped.length > 0
		? skipped.map((file) => `✗ ${file.relativePath}`).join('\n')
		: 'None';
	
		return `Orbit initialized this project.
	
Created:
${createdText}
Skipped:
${skippedText}
`;
	}


	const handleSubmitQuery = async (value: string) => {
		const prompt = value.trim();

		if (!prompt) return;
		setQuery('');

		const commandHandled = await runCommand(prompt, {
			setMessages,
			setQuery,
			setIsThinking,
			setSelectProjectMode,
			setProjectOptions,
			setIsInitting,
			setReInit,
			project,
			isThinking,
			constructProjectOptions,
			setProject,
			setCheckName,
			setConfirmName,
			startAbortableTask,
  			clearAbortableTask,
  			abortCurrentTask,
			setConfirmDeinit,
		});

		if (commandHandled) {
			return;
		}

		if (isThinking) {
			setMessages((prev) => [
				...prev,
				{
					role: 'agent',
					content: "There is ongoing task Orbit is handling. You can use the /abort command to terminate previous task",
					color: "red"
				},
			]);
			return;
		}

		setMessages((prev) => [
			...prev,
			{
				role: 'user',
				content: prompt,
			},
		]);

		setIsThinking(true);
		setMessages((prev) => [
			...prev,
			{
			role: 'agent',
			content: "This is a fake response from Orbit",
			},
		]);
		setIsThinking(false);
};


	const handleProjectPath = () => {
		setMessages([
			{
				role: 'system',
				content: `Received Project Path: ${inputPath}`,
			},
		]);
		const res = validateProjectPath(inputPath);
		if (!res.ok) {
			setMessages((prev) => [
				...prev,
				{
					role: 'system',
					content: `Project path ${res.path} does not exist`,
				},
			]);
		} else {
			const checkProject = detectProjectRoot(res.path);
			if (checkProject.isProject) {
				setMessages((prev) => [
					...prev,
					{
						role: 'system',
						content: `Project detected: ${checkProject.root}`,
					},
				]);
			} else {
				setMessages((prev) => [
					...prev,
					{
						role: 'system',
						content: `Please ensure the path direct Orbit to a project`,
					},
				]);
			}
		}
		setSelectProjectMode(false);
		setInputPath("");
		setSelectedProjectOption("");
	}


	const handleConfirmNameInit = async () => {
		if (project) {
			try {
				const result = initOrbitProject({
					projectName: confirmName,
					projectRoot: project.root || '',
					framework: project.framework,
					packageManager: project.packageManager,
					testFramework: project.testFramework,
				});
			
				rememberProject({
					name: confirmName,
					path: project.root || '',
					framework: project.framework ?? null,
					packageManager: project.packageManager ?? null,
					testFramework: project.testFramework ?? null,
					lastScannedAt: null,
				});
			
				setMessages((prev) => [
					...prev,
					{
						role: 'agent',
						content: `${formatInitResult(result.files)}
Global memory updated:
✓ ~/.orbit/projects.json`,
						color: 'green',
					},
				]);
			
				setProject?.((prev) =>
					prev
						? {
							...prev,
							hasOrbitFolder: true,
						}
						: prev,
				);
				// Fused the scan project in the init as well.
				if (project.root) {
					const projectMap = await scanProject(project.root);
					const projectMapPath = writeProjectMap(project.root, projectMap);

					setMessages((prev) => [
						...prev,
						{
							role: 'agent',
							content: formatScanResult(projectMap, projectMapPath),
							color: 'green',
						},
					]);
				}
				
			}
			catch (error) {
				setMessages((prev) => [
					...prev,
					{
						role: 'system',
						content: `Failed to initialize Orbit context: ${
							error instanceof Error ? error.message : String(error)
						}`,
						color: 'red',
					},
				]);
			} finally {
				setIsInitting(false);
				setCheckName(false);
				setConfirmName("");
			}
		}
	}


	const handleConfirmDeinit = (item: any) => {
		if (item.value === 'confirm') {
			setIsThinking(true);
			if (project) {
				const projectPath = getProjectPath(project);
				if (!projectPath.ok) {
					setMessages((prev) => [
						...prev,
						{
							role: 'system',
							content: `${projectPath.context}`,
							color: 'red',
						},
					]);
				} else {
					const path = projectPath.route;
					deinitContext(path);
					if (project) {
						project.hasOrbitFolder = false;
					}
					setMessages((prev) => [
						...prev,
						{
							role: 'system',
							content: `Orbit context of ${path} deleted successfully`,
							color: 'green',
						},
					]);
				}
			}
		}
		setIsThinking(false);
		setConfirmDeinit(false);
	}


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
				<Text>Run Orbit inside a project or choose a recent project.</Text>
			</>
			)}

			<Text>
				Approval: <Text color="yellow">Ask before write/run</Text>
			</Text>
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

		{isBooting || selectProjectMode || reInit || confirmDeinit ? (
			<Box marginTop={1}>
				<Text color="yellow">
					<Spinner type="dots" /> Selection Menu In Progress...
				</Text>
			</Box>
			) : (
			<Box marginTop={1}>
				<Text color="cyan">{'> '}</Text>
				<TextInput
					value={query}
					onChange={setQuery}
					onSubmit={handleSubmitQuery}
					placeholder="Ask Orbit to test something"
				/>
				{ghostCompletetion && (
					<Text dimColor>{ghostCompletetion}</Text>
				)}
			</Box>
		)}

		{
			selectProjectMode && (
			<Box flexDirection="column">
				<Text>Select an option (Use arrow keys and Enter):</Text>
				<SelectInput
					items={projectOptions}
					onSelect={handleProjectSelect}
				/>
			</Box>
		)}

		{
			selectedProjectOption === "add" &&
			<Box marginTop={1}>
				<TextInput
					value={inputPath}
					onChange={setInputPath}
					onSubmit={handleProjectPath}
					placeholder="Type Project Path (FROM HOME)"
				/>
			</Box>
		}

		{
			isInitting && (
				<Text color="yellow">
					<Spinner type="dots" /> Initializing Orbit Context...
				</Text>
			)
		}

		{
			checkName && (
				<Box marginTop={1} flexDirection='column'>
					<Text>The following name is detected. You can type in your own</Text>
					<TextInput
						value={confirmName}
						onChange={setConfirmName}
						onSubmit={handleConfirmNameInit}
						placeholder="Your Project Name"
					/>
				</Box>
			)
		}

		{
			isThinking && (
				<Text color="yellow">
					<Spinner type="dots" /> Orbit's thinking...
				</Text>
			)
		}

		{
			confirmDeinit && (
				<Box flexDirection="column">
					<Text color="red">Are you sure to deinit orbit context for this project. All context will be deleted after this</Text>
					<SelectInput
						items={confirmationOptions}
						onSelect={handleConfirmDeinit}
					/>
				</Box>
			)
		}

		<Box marginTop={1}>
			<Text color="red">Type '/exit' to quit</Text>
		</Box>
    </Box>
  );
}