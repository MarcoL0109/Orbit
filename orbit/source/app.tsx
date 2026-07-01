import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { detectProjectRoot } from './projects/search.js';
import { validateProjectPath } from './projects/path.js';
import SelectInput from 'ink-select-input';
import type { Message, ProjectOptions, ProjectInfo } from './commands/context.js'
import { runCommand } from './commands/rumCommand.js';
import { getBestCommandCompletion, getGhostCompletion } from './commands/autocomplete.js';


type AppProps = {
	initialPrompt?: string;
}


export function App({ initialPrompt }: AppProps) {
	const [messages, setMessages] = useState<Message[]>([]);
	const [query, setQuery] = useState<string>("");
	const [isBooting, setIsBooting] = useState(true);
	const [isThinking, setIsThinking] = useState(false);
	const [project, setProject] = useState<ProjectInfo | null>(null);
	const [selectProjectMode, setSelectProjectMode] = useState<boolean>(false);
	const [projectOptions, setProjectOptions] = useState<ProjectOptions[]>([]);
	const [selectedOption, setSelectedOption] = useState<string>("");
	const [inputPath, setInputPath] = useState<string>("");
	const ghostCompletetion = getGhostCompletion(query);

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
				// For now just use fake options (but here should be project path or names that is in Orbit's global memory)
				setSelectProjectMode(true);
				constructProjectOptions();
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


	const handleSelect = (item: any) => {
		setSelectedOption(item.value);
		if (selectedOption === 'exit') {
			process.exit(0);
		}
		if (selectedOption === 'quit') {
			setSelectProjectMode(false);
		}
	}


	const constructProjectOptions = () => {
		const options = [
			{ label: 'Option 1: Orbit', value: 'red' },
			{ label: 'Option 2: Redemption', value: 'yellow' },
			{ label: 'Option 3: Salary', value: 'orange' },
			{ label: 'Option 4: WOW', value: 'blue' },
			{ label: 'Option 5: Add New Project', value: 'add' },
			{ label: 'Option 6: Quit Orbit', value: 'exit' },
		];
		if (project) {
			options.push({
				label: 'Option 7: Exit Menu',
				value: 'quit',
			});
		}
		return options;
};


	const handleSubmitQuery = async (value: string) => {
		const prompt = value.trim();

		if (!prompt) return;

		setQuery('');

		setMessages((prev) => [
			...prev,
			{
			role: 'user',
			content: prompt,
			},
		]);

		const commandHandled = await runCommand(prompt, {
			setMessages,
			setQuery,
			setIsThinking,
			setSelectProjectMode,
			setProjectOptions,
			project,
			constructProjectOptions,
		});

		if (commandHandled) {
			return;
		}

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
		setSelectedOption("");
	}


  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1} flexDirection="column">
		<Box justifyContent="space-between">
			<Text bold>🪐 Orbit</Text>
			<Text color="cyan">Interactive Mode</Text>
		</Box>

		<Text dimColor>AI QA agent for E2E testing</Text>

		<Box marginTop={1} flexDirection="column">
			{isBooting && (
			<Text color="yellow">
				<Spinner type="dots" /> Detecting project context...
			</Text>
			)}

			{!isBooting && project?.isProject && (
			<>
				<Text>
					Project Path: <Text dimColor>{project.root}</Text>
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
						{project.hasOrbitFolder ? '.orbit found' : 'not initialized'}
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
				<Text key={index} dimColor={message.role === 'system'}>
					{message.role === 'user'
						? `You: ${message.content}`
						: message.role === 'agent'
						? `Orbit: ${message.content}`
						: message.content}
				</Text>
			))}
		</Box>

		{isBooting || selectProjectMode ? (
			<Box marginTop={1}>
				<Text color="yellow">
				<Spinner type="dots" /> Detecting project...
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

		{selectProjectMode && (
			<Box flexDirection="column">
				<Text>Select an option (Use arrow keys and Enter):</Text>
				<SelectInput
					items={projectOptions}
					onSelect={handleSelect}
				/>
			</Box>
		)}

		{
			selectedOption === "add" &&
			<Box marginTop={1}>
				<TextInput
					value={inputPath}
					onChange={setInputPath}
					onSubmit={handleProjectPath}
					placeholder="Type Project Path (FROM HOME)"
				/>
			</Box>
		}

		<Box marginTop={1}>
			<Text color="red">Type '/exit' to quit</Text>
		</Box>
    </Box>
  );
}