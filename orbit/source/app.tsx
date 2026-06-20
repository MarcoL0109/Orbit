import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

type AppProps = {
  initialPrompt?: string;
};

export function App({ initialPrompt }: AppProps) {
	const [messages, setMessages] = useState<string[]>([
	initialPrompt
		? `User asked: ${initialPrompt}`
		: 'Ready. What would you like to test?',
	]);

	useInput((input, key) => {
	if (key.return) {
		setMessages((prev) => [...prev, 'Orbit: I will start planning this QA task.']);
	}

	if (input === 'q') {
		process.exit(0);
	}
	});

	return (
		<Box flexDirection="column">
			<Box borderStyle="round" paddingX={1}>
				<Text bold>◯ Orbit</Text>
			</Box>

			<Box marginTop={1} flexDirection="column">
				{messages.map((message, index) => (
					<Text key={index}>{message}</Text>
				))}
			</Box>

			<Box marginTop={1}>
				<Text dimColor>Press q to quit</Text>
			</Box>
		</Box>
	);
}