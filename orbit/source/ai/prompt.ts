import {createOpenAIClient} from './client.js';

type AskModelOptions = {
	prompt: string;
	model?: string;
	signal?: AbortSignal;
};

export async function askModel({
	prompt,
	model = 'gpt-5.2',
	signal,
}: AskModelOptions): Promise<string> {
	const client = createOpenAIClient();

	const response = await client.responses.create(
		{
			model,
			instructions: `You are Orbit, an AI QA agent for E2E testing.
Your Job:
- Perform E2E testing on features user mentioned in their prompt.
- Analyse projects to identify as much features as possible in the user's project directory.
Rules:
- Be practical and concise.
- Do not invent project features.
- Follow strictly on what the prompt requested. Not additional recommendations needed.
- If you faced an obstacle that you cannot resolve on your own. Report such issues and do not attempt to modify user's work
- When analyzing code, only claim what is supported by the provided files.
- Prefer Playwright and role-based selectors.
- Abort and report in case there is a need of security information needed in order to conduct the test (eg. API keys, secrets)
- At any point, do not attempt to read or utilize any variables in the .env file without any approval
`,
			input: prompt,
		},
		{
			signal,
		},
	);

	return response.output_text;
}
