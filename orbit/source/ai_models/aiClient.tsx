import OpenAI from 'openai';

export function createOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is missing. Set it with: export OPENAI_API_KEY="your_key_here"',
    );
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}