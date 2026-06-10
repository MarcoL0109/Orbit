import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink'; // Added useStdout
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';

interface AgentRunnerProps {
	endpoint: string;
}

export default function AgentRunner({ endpoint }: AgentRunnerProps) {
	const [isRunning, setIsRunning] = useState(true);
	const [status, setStatus] = useState('Connecting to LangChain agent...');
	const [agentLogs, setAgentLogs] = useState<string[]>([]);
	const [query, setQuery] = useState('');
	const [history, setHistory] = useState<string[]>([]);
	const [loading, setLoading] = useState<boolean>(false);
	const [response, setResponse] = useState<string>("");

	const { exit } = useApp();
	
	const { stdout } = useStdout();
	const terminalWidth = stdout ? stdout.columns : 80; 

	const contentWidth = terminalWidth - 4; 

	const separatorLine = '─'.repeat(Math.max(10, contentWidth));

	const handleSubmit = async (value: string) => {
		const trimmedValue = value.trim();
		if (!trimmedValue) return;
		setHistory((prevHistory) => [...prevHistory, trimmedValue]);
		setQuery('');
		setLoading(true);
		await computeResponse();
	};


	const computeResponse = async () => {
		await new Promise(r => setTimeout(r, 2000));
		setResponse("Orbit has computed some response");
		setLoading(false);
	}

	useInput((input) => {
		if (input === 'q' || input === 'Q') {
			setIsRunning(false);
			exit();
		}
		if (input === ' ') {
			setIsRunning(!isRunning);
		}
	});

	useEffect(() => {
		if (!isRunning) {
			setStatus('Agent paused. Ready for configuration input.');
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

	const lastCommand = history.length > 0 ? history[history.length - 1] : null;

	return (
		<Box flexDirection="column" paddingX={2} paddingY={1} width="100%">
			
			<Box justifyContent="space-between" marginBottom={1}>
				<Box>
					<Text color="black" backgroundColor="cyan" bold> ✦ ORBIT </Text>
					<Text color="cyan" bold> ENGINE </Text>
					<Text color="gray">|</Text>
					<Text color="gray"> {endpoint}</Text>
				</Box>
				<Box>
					{isRunning ? (
						<Text color="green"><Spinner type="dots" /> ACTIVE </Text>
					) : (
						<Text color="yellow">⏸ PAUSED </Text>
					)}
				</Box>
			</Box>

			<Box marginBottom={1}>
				<Text color="gray">System: {status}</Text>
			</Box>

			<Text color="gray">{separatorLine}</Text>

			<Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={2}>
				<Text color="gray" bold dimColor>LIVE PIPELINE STREAM</Text>
				
				{agentLogs.length === 0 ? (
					<Text color="gray" dimColor>  No context pipelines initialized yet...</Text>
				) : (
					agentLogs.slice(-3).map((log, index) => (
						<Box key={index} marginTop={0.5}>
							<Text color="magenta">⌁</Text>
							<Text color="white"> {log}</Text>
						</Box>
					))
				)}
			</Box>

			<Text color="gray">{separatorLine}</Text>

			{lastCommand && (
				<Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={2}>
					<Text color="gray" dimColor>LAST EVALUATED COMMAND</Text>
					<Text color="cyan">↳ {lastCommand}</Text>
				</Box>
			)}

			{
				loading && (
					<Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={2}>
						<Text color="yellow"><Spinner type="dots" /> </Text>
					</Box>
				)
			}

			{
				!loading && response && (
					<Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={2}>
						<Text color="yellow">{response} </Text>
					</Box>
				)
			}

			<Box marginTop={1} marginBottom={1}>
				<Text color="magenta" bold>❯ </Text>
				<TextInput 
					value={query} 
					onChange={setQuery} 
					onSubmit={handleSubmit}
					placeholder="Ask orbit agent to build or analyze runtime suites..."
				/>
			</Box>

			<Box marginTop={1}>
				<Text color="gray" dimColor>Controls: </Text>
				<Text color="darkGray">[</Text><Text color="cyan">Space</Text><Text color="darkGray">]</Text>
				<Text color="gray" dimColor> {isRunning ? 'Pause Engine' : 'Resume Engine'} </Text>
				<Text color="gray" dimColor> • </Text>
				<Text color="darkGray">[</Text><Text color="red">Q</Text><Text color="darkGray">]</Text>
				<Text color="gray" dimColor> Terminate Sess </Text>
			</Box>

		</Box>
	);
}