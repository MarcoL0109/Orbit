import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Global, not per-project: what this tracks (how much of the OpenAI account
// has been used) is an account-wide concern, not something scoped to one
// project's own .orbit folder.
export type UsageStats = {
	inputTokens: number;
	outputTokens: number;
	// null specifically means "never recorded or reset" — no file has ever
	// been written, as opposed to a real (if old) timestamp. Kept distinct
	// rather than defaulting to "now" so readGlobalUsage stays a pure read:
	// calling it twice with no file present must return the same answer
	// both times, not a fresh Date() each call.
	since: string | null;
};

function getGlobalUsagePath() {
	return path.join(os.homedir(), '.orbit', 'usage.json');
}

const neverTracked: UsageStats = {inputTokens: 0, outputTokens: 0, since: null};

export function readGlobalUsage(): UsageStats {
	const usagePath = getGlobalUsagePath();

	if (!fs.existsSync(usagePath)) {
		return neverTracked;
	}

	const raw = fs.readFileSync(usagePath, 'utf8');

	if (!raw.trim()) {
		return neverTracked;
	}

	try {
		return JSON.parse(raw) as UsageStats;
	} catch {
		return neverTracked;
	}
}

function writeGlobalUsage(data: UsageStats) {
	const usagePath = getGlobalUsagePath();

	fs.mkdirSync(path.dirname(usagePath), {recursive: true});
	fs.writeFileSync(usagePath, JSON.stringify(data, null, 2), 'utf8');
}

// Called once per model response (see agentLoop.ts's onUsage) — reads,
// adds, writes back every time rather than batching, same tradeoff already
// made for the exploration graph design: the file is small and local, so
// per-call I/O costs nothing next to the network round trip that produced
// the usage numbers in the first place.
export function recordUsage(inputTokens: number, outputTokens: number): void {
	const current = readGlobalUsage();

	writeGlobalUsage({
		inputTokens: current.inputTokens + inputTokens,
		outputTokens: current.outputTokens + outputTokens,
		// The first-ever recording is what actually starts the clock — a
		// still-null since here means no file existed before this call.
		since: current.since ?? new Date().toISOString(),
	});
}

export function resetGlobalUsage(): void {
	writeGlobalUsage({
		inputTokens: 0,
		outputTokens: 0,
		since: new Date().toISOString(),
	});
}

// gpt-5.2 pricing in USD per 1,000,000 tokens, confirmed by the user
// directly rather than guessed — OpenAI prices input/output separately and
// this codebase has no way to fetch the current rate itself, so this is a
// point-in-time snapshot that WILL go stale if pricing changes. Update
// these two numbers when it does; nothing else needs to change, since
// every caller goes through estimateCostUsd rather than hardcoding a rate
// of its own.
const INPUT_PRICE_PER_MILLION_TOKENS_USD = 1.75;
const OUTPUT_PRICE_PER_MILLION_TOKENS_USD = 14;

export function estimateCostUsd(usage: {
	inputTokens: number;
	outputTokens: number;
}): number {
	return (
		(usage.inputTokens / 1_000_000) * INPUT_PRICE_PER_MILLION_TOKENS_USD +
		(usage.outputTokens / 1_000_000) * OUTPUT_PRICE_PER_MILLION_TOKENS_USD
	);
}
