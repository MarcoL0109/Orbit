import {createOpenAIClient} from './aiClient.js';


type AskModelOptions = {
  prompt: string;
  model?: string;
};

export async function askModel({
  prompt,
  model = 'gpt-5.2',
}: AskModelOptions): Promise<string> {
  const client = createOpenAIClient();

  const response = await client.responses.create({
    model,
    instructions: `You are Orbit, an AI QA agent for E2E testing.

Rules:
- Be practical and concise.
- Do not invent project features.
- When analyzing code, only claim what is supported by the provided files.
- Prefer Playwright and role-based selectors.
- Abort and report in case there is a need of security information needed in order to conduct the test (eg. API keys, secrets)
`,
    input: prompt,
  });

  return response.output_text;
}