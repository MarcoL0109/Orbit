import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import Spinner from 'ink-spinner';


interface AgentRunnerProps {
	endpoint: string;
}

export default function AgentRunner({ endpoint }: AgentRunnerProps) {
	const [isRunning, setIsRunning] = useState(true);
	const [status, setStatus] = useState('Connecting to LangChain agent...');
	const [agentLogs, setAgentLogs] = useState<string[]>([]);
	
	const { exit } = useApp();

	useInput((input) => {
		if (input === 'q') {
			setIsRunning(false);
			exit();
		}

	});

	useEffect(() => {
		if (!isRunning) {
			setStatus('Agent paused. Press [SPACE] to resume...');
			return;
		}

		setStatus('Agent is actively executing tasks...');
		
		const controller = new AbortController();

		async function fetchAgentUpdates() {
			try {
				const response = await fetch(`${endpoint}/agent/run`, {
					method: 'POST',
					signal: controller.signal,
					headers: { 'Content-Type': 'application/json' }
				});

				if (!response.ok) throw new Error('API server error');
				
				const data = await response.json();
				
				// Expecting your Python API to return { status: "...", logs: [...] }
				if (data.status) setStatus(data.status);
				if (data.logs) setAgentLogs(data.logs);

			} catch (error: any) {
				if (error.name !== 'AbortError') {
					setStatus(`Error reaching backend: ${error.message}`);
				}
			}
		}

		fetchAgentUpdates();
		const interval = setInterval(fetchAgentUpdates, 1500);

		return () => {
			clearInterval(interval);
			controller.abort();
		};
	}, [isRunning, endpoint]);

	return (
		<Box flexDirection="column" padding={1} borderStyle="round" borderColor="yellow">
			{/* <BackgroundIcon imagePath="./assets/orbit.png" width={45} /> */}
			<Box marginBottom={1} justifyContent="space-between">
				<Text color="black" backgroundColor="yellow" bold> ORBIT AGENT RUNNER </Text>
				<Text color="gray">{endpoint}</Text>
			</Box>

			<Box marginBottom={1}>
				{isRunning ? (
					<Text color="green"><Spinner type="dots" /> {status}</Text>
				) : (
					<Text color="red">🛑 {status}</Text>
				)}
			</Box>

			<Box flexDirection="column" marginBottom={1} minHeight={3}>
				<Text color="gray" italic>Latest Agent Activity:</Text>
				{agentLogs.slice(-2).map((log, index) => (
					<Text key={index} color="cyan">› {log}</Text>
				))}
				{agentLogs.length === 0 && <Text dimColor> No activities logged yet.</Text>}
			</Box>
			
			<Box borderStyle="single" borderColor="gray" paddingX={1}>
				<Text dimColor>Controls: </Text>
				<Text color="cyan" bold> [SPACE] </Text>
				<Text dimColor>{isRunning ? 'Pause' : 'Resume'} | </Text>
				<Text color="red" bold> [Q] </Text>
				<Text dimColor>Stop & Exit</Text>
			</Box>
		</Box>
	);
}