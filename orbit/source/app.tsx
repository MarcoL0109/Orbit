import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { detectProjectRoot } from './search.js';


type AppProps = {
  initialPrompt?: string;
};

type Message = {
  role: 'user' | 'agent' | 'system';
  content: string;
};

export function App({ initialPrompt }: AppProps) {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'system',
      content: initialPrompt ?? 'Orbit is up and running',
    },
  ]);

  const [query, setQuery] = useState<string>('');
  const [isThinking, setIsThinking] = useState(false);

  const handleSubmitQuery = async (value: string) => {
	const prompt = value.trim();

	if (!prompt) return;

	if (prompt.toLowerCase() === '/exit') {
		process.exit(0);
	}

	setQuery('');

	if (prompt.toLowerCase() === '/search') {
		const res = detectProjectRoot();

		setMessages((prev) => [
		...prev,
		{
			role: 'user',
			content: prompt,
		},
		{
			role: 'agent',
			content: formatProjectDetectionResult(res),
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

	const agentResponse = await fakeAgentResponse(prompt);

	setMessages((prev) => [
		...prev,
		{
		role: 'agent',
		content: agentResponse,
		},
	]);

	setIsThinking(false);
	};


  function formatProjectDetectionResult(result: ReturnType<typeof detectProjectRoot>): string {
	if (!result || !result.isProject) {
		return `No project detected in this directory.

	Try:
	- cd into a project folder
	- run Orbit from inside your app
	- use /projects to choose a remembered project later`;
	}

	return `Project detected

		Root:
		${result.root}

		Confidence:
		${result.confidence}%

		Markers:
		${result.markers.length > 0 ? result.markers.join(', ') : 'None'}

		Package manager:
		${result.packageManager ?? 'Not Detected'}

		Framework:
		${result.framework ?? 'Not Detected'}

		Test framework:
		${result.testFramework ?? 'Not Detected'}`;
	}

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold>🪐 Orbit</Text>
          <Text color="yellow">Interactive Mode</Text>
        </Box>

        <Text dimColor>AI QA agent for E2E testing</Text>

        <Box marginTop={1} flexDirection="column">
        	<Text>
            	Project: <Text color="cyan">orbit</Text>
          	</Text>
			<Text>
				Project Path:{' '}
				<Text dimColor>~/Documents/GitHub/Orbit/orbit</Text>
			</Text>
			<Text>
				Detected Stack:{' '}
				<Text color="green">TypeScript + Ink + Playwright</Text>
			</Text>
          	<Text>
            	Approval:{' '}
            	<Text color="yellow">Need Consent From User</Text>
          	</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
    	{messages.map((message, index) => (
          <Box key={index} marginBottom={1} flexDirection="column">
            {message.role === 'user' && (
              <>
                <Text color="cyan" bold>
                  You:
                </Text>
                <Text>{message.content}</Text>
              </>
            )}

            {message.role === 'agent' && (
              <>
                <Text color="green" bold>
                  Orbit:
                </Text>
                <Text>{message.content}</Text>
              </>
            )}

            {message.role === 'system' && (
              <Text dimColor>{message.content}</Text>
            )}
          </Box>
        ))}

        {isThinking && (
          <Box marginBottom={1}>
            <Text color="yellow"><Spinner type="dots" /> Thinking...</Text>
          </Box>
        )}
      </Box>

      <Box>
        <Text color="cyan">{'> '}</Text>
        <TextInput
          value={query}
          onChange={setQuery}
          onSubmit={handleSubmitQuery}
          placeholder="Ask Orbit to test something"
        />
      </Box>

      <Box marginTop={1}>
        <Text color="red">Type '/exit' to quit</Text>
      </Box>
    </Box>
  );
}

async function fakeAgentResponse(prompt: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 500));

  return `I will create a QA plan for: "${prompt}"
Plan:
1. Inspect the project routes
2. Check existing Playwright tests
3. Generate an E2E test
4. Ask for approval before running commands`;
}