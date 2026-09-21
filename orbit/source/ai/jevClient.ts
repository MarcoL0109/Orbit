import {TypeSafeClient} from '@typesafe-ai/sdk';

// Mirrors client.ts's createOpenAIClient — same shape, same reasoning: throw
// early with an actionable message rather than let a missing key surface as
// an opaque failure deep inside whatever first calls systemOne. Kept as a
// separate client/module from client.ts on purpose (see the "Seeding a
// precondition" design discussion this followed) — Jev is a different
// provider with a different request/response shape entirely (typed
// decisions, not chat/tool-call completions), not another OpenAI model ID to
// swap in.
export function createJevClient(): TypeSafeClient {
	const apiKey = process.env['TYPESAFE_API_KEY'];
	if (!apiKey) {
		throw new Error(
			'TYPESAFE_API_KEY is missing. Set it with: export TYPESAFE_API_KEY="your_key_here"',
		);
	}

	return new TypeSafeClient({apiKey});
}

// Unlike createOpenAIClient/createJevClient, this never throws — Jev is a
// strictly optional enhancement in the main agent loop (see
// seedRequestJev.ts's own fallback design), not a hard dependency the way
// OPENAI_API_KEY is. A project with no TYPESAFE_API_KEY set just runs
// without it, silently, the same as a project with no graphify graph runs
// without explain_symbol.
export function tryCreateJevClient(): SystemOneClient | null {
	if (!process.env['TYPESAFE_API_KEY']) {
		return null;
	}

	return createJevClient();
}

// Only the method callers actually use — same reasoning as client.ts's own
// ResponsesClient: accepted as a dependency rather than the concrete class,
// so anything that calls systemOne is testable with a fake client instead
// of a live API key.
export type SystemOneClient = {
	systemOne: TypeSafeClient['systemOne'];
};

export type {
	ChoiceQuestion,
	ChoiceResponse,
	Questions,
	SystemOneResult,
} from '@typesafe-ai/sdk';
export {choice, noul, score} from '@typesafe-ai/sdk';
