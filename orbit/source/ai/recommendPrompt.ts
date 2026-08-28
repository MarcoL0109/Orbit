import fs from 'node:fs';
import path from 'node:path';
import type {Message} from '../commands/context.js';
import {readProjectMap} from '../projects/scan.js';
import {readProjectMemory} from '../init/memory.js';
import {computeCoverage, formatCoverageSummary} from '../projects/coverage.js';
import {createOpenAIClient, type ResponsesClient} from './client.js';
import {summarizeProjectMap, summarizeMemory} from './agent.js';
import {getOrbitDir} from '../init/orbitDir.js';

type StoredSession = {
	prompt: string;
	status: string;
	summary: string;
};

// Sessions are named by ISO timestamp (see writeAgentSession), so a plain
// lexical sort is also a chronological one — no need to stat/parse dates.
function readLatestSession(projectRoot: string): StoredSession | null {
	const sessionsDir = path.join(getOrbitDir(projectRoot), 'sessions');
	if (!fs.existsSync(sessionsDir)) return null;

	const files = fs
		.readdirSync(sessionsDir)
		.filter(name => name.endsWith('.json'))
		.sort();
	const latest = files[files.length - 1];
	if (!latest) return null;

	try {
		return JSON.parse(
			fs.readFileSync(path.join(sessionsDir, latest), 'utf8'),
		) as StoredSession;
	} catch {
		return null;
	}
}

const MAX_CONVERSATION_MESSAGES = 6;

// Drops the dim, gray "→ Reading project files..." step-progress lines
// (see describeAgentActivity/describeAgentStepOutcome) — transient noise
// about what a tool call is doing, never something worth following up on —
// and keeps only the last few real exchanges, not the whole transcript.
function summarizeRecentConversation(messages: Message[]): string {
	const real = messages.filter(message => !message.dim);
	const tail = real.slice(-MAX_CONVERSATION_MESSAGES);

	if (tail.length === 0) return 'No conversation yet this session.';

	return tail
		.map(message => `${message.role}: ${message.content}`)
		.join('\n\n');
}

const RECOMMENDATION_SCHEMA = {
	type: 'object',
	properties: {
		prompt: {
			type: ['string', 'null'],
			description:
				'One short prompt the user could type to Orbit right now, phrased exactly as they would type it — a question, or a /test request. Null if nothing genuinely stands out.',
		},
	},
	required: ['prompt'],
	additionalProperties: false,
};

// Single-shot, not agentic — same reasoning as classifyFileFeatures: this is
// pure judgment from context already in hand, nothing to iterate on or take
// action with, so it skips the tool-call loop entirely. Deliberately not
// wired through the same abort controller a real /test or ask run uses —
// this is background, best-effort, low-priority work that shouldn't compete
// with or be tied to the user's own in-flight request.
export async function generateRecommendedPrompt(
	projectRoot: string,
	recentMessages: Message[] = [],
	client: ResponsesClient = createOpenAIClient(),
	signal?: AbortSignal,
): Promise<string | null> {
	const projectMap = readProjectMap(projectRoot);
	const memory = readProjectMemory(projectRoot);
	const latestSession = readLatestSession(projectRoot);
	const coverageSummary = projectMap
		? formatCoverageSummary(computeCoverage(projectMap, projectRoot))
		: 'No project index yet — nothing has been scanned.';

	const instructions = `You are Orbit, an AI QA agent for E2E testing. Suggest ONE short, specific next prompt the user might genuinely want to type to Orbit right now. Phrase it exactly as the user would type it themselves, not as advice about what they should do. If nothing below actually stands out, return null rather than inventing a generic filler suggestion — a wrong or bland suggestion is worse than none.

Check in this order:
1. Look at the recent conversation below first. If your own most recent message in it ends with an offer or a question you asked the user that they haven't answered yet (e.g. "if you want, I can also trace X" or "want me to check Y?"), that offer IS the recommendation — phrase it as the user accepting it in their own words (e.g. "yes, do that" or restating the specific thing you offered), not as something unrelated. This takes priority over everything else below.
2. Only if there's no such pending offer (or the conversation is empty/unrelated to testing), fall back to the project's state: a recent test failure worth digging into, an obvious coverage gap, or — for a brand new project with no history at all — a natural first question about what the project does.

Orbit's own input has no CLI-style flags or options anywhere — not "--debug", not a file path argument, nothing like that. A /test prompt is nothing but a plain-English feature description (e.g. "/test user can log in with valid credentials and sees the dashboard"); a plain question is nothing but plain English too. Never invent flag-like or argument-like syntax that doesn't exist — if you're tempted to add something like that, just say it in plain words instead (e.g. ask what broke, or what a specific selector/assertion was, in a normal sentence).

Recent conversation (oldest first):
${summarizeRecentConversation(recentMessages)}

${summarizeProjectMap(projectMap, [])}

${coverageSummary}

${
	latestSession
		? `Most recent test run: "${latestSession.prompt}" — ${latestSession.status}. ${latestSession.summary}`
		: 'No test has been run yet for this project.'
}

Project memory:
${summarizeMemory(memory)}`;

	try {
		const response = await client.responses.create(
			{
				model: 'gpt-5.2',
				instructions,
				input: 'Suggest a next prompt, or null.',
				text: {
					format: {
						type: 'json_schema',
						name: 'recommended_prompt',
						schema: RECOMMENDATION_SCHEMA,
						strict: true,
					},
				},
			},
			signal ? {signal} : undefined,
		);

		const parsed = JSON.parse(response.output_text) as {prompt: string | null};
		const trimmed = parsed.prompt?.trim() ?? '';
		return trimmed === '' ? null : trimmed;
	} catch {
		return null;
	}
}
