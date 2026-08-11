import OpenAI from 'openai';
import type {
	Response,
	ResponseCreateParamsNonStreaming,
} from 'openai/resources/responses/responses';

// Only what callers actually use — accepted as a dependency rather than
// constructed internally by consumers, so they're testable without a live
// API key. Shared here (rather than defined per-consumer) since both the
// agent loop and the single-shot feature classifier need the same shape.
export type ResponsesClient = {
	responses: {
		create: (
			parameters: ResponseCreateParamsNonStreaming,
			options?: {signal?: AbortSignal},
		) => Promise<Response>;
	};
};

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
