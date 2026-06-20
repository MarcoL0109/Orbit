import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { detectProjectRoot } from './search.js';


type ProjectInfo = {
  isProject: boolean;
  root: string | null;
  confidence: number;
  markers: string[];
  framework?: string;
  packageManager?: string;
  testFramework?: string;
  hasOrbitFolder?: boolean;
};

type Message = {
  role: 'user' | 'agent' | 'system';
  content: string;
};

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState('');
  const [isBooting, setIsBooting] = useState(true);
  const [project, setProject] = useState<ProjectInfo | null>(null);

  useEffect(() => {
    async function bootOrbit() {
      setIsBooting(true);

      const detectedProject = detectProjectRoot();

      setProject(detectedProject);

      if (detectedProject.isProject && detectedProject.root) {
        setMessages([
          {
            role: 'system',
            content: `Project detected: ${detectedProject.root}`,
          },
        ]);
      } else {
		// I need to add a project selection mode in this block
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

  const handleSubmitQuery = async (value: string) => {
    const prompt = value.trim();
    if (!prompt) return;

    if (prompt.toLowerCase() === '/exit') {
      process.exit(0);
    }

    setQuery('');

    setMessages((prev) => [
      ...prev,
      {
        role: 'user',
        content: prompt,
      },
    ]);

    // Agent logic here
  };

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" paddingX={1} flexDirection="column">
		<Box justifyContent="space-between">
			<Text bold>🪐 Orbit</Text>
			<Text color="yellow">Interactive Mode</Text>
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
				<Text color="yellow">No project detected</Text>
				<Text dimColor>Run Orbit inside a project or choose a recent project.</Text>
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

      {isBooting ? (
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
        </Box>
      )}
	  <Box marginTop={1}>
        <Text color="red">Type '/exit' to quit</Text>
      </Box>
    </Box>
  );
}