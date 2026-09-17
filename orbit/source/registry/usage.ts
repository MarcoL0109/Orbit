import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ModelUsage = {
	inputTokens: number;
	outputTokens: number;
};

// Global, not per-project: what this tracks (how much of the OpenAI account
// has been used) is an account-wide concern, not something scoped to one
// project's own .orbit folder. Keyed by model, not a single flat total —
// this codebase now runs five different agents that can each be configured
// (per-project, via /config) to a different model, each with its own
// price, so a single pair of input/output counters could never be priced
// correctly once more than one model is actually in use. estimateCostUsd
// is the only thing that needs the breakdown; everything that only cares
// about totals (the /usage display) can sum across it.
export type UsageStats = {
	byModel: Record<string, ModelUsage>;
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

const neverTracked: UsageStats = {byModel: {}, since: null};

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
		const parsed = JSON.parse(raw) as Partial<UsageStats> &
			Partial<ModelUsage>;
		// A usage.json written before per-model tracking existed has flat
		// inputTokens/outputTokens instead of byModel — fold it in under an
		// "unknown" bucket rather than discarding it, so switching Orbit
		// versions doesn't silently zero out real history. New writes are
		// always the byModel shape; this is a read-time migration only.
		if (parsed.byModel) {
			return {byModel: parsed.byModel, since: parsed.since ?? null};
		}
		if (
			typeof parsed.inputTokens === 'number' ||
			typeof parsed.outputTokens === 'number'
		) {
			return {
				byModel: {
					unknown: {
						inputTokens: parsed.inputTokens ?? 0,
						outputTokens: parsed.outputTokens ?? 0,
					},
				},
				since: parsed.since ?? null,
			};
		}
		return neverTracked;
	} catch {
		return neverTracked;
	}
}

function writeGlobalUsage(data: UsageStats) {
	const usagePath = getGlobalUsagePath();

	fs.mkdirSync(path.dirname(usagePath), {recursive: true});
	fs.writeFileSync(usagePath, JSON.stringify(data, null, 2), 'utf8');
}

// Called once per model response (see agentLoop.ts's onUsage, plus the two
// single-shot callers that report their own usage directly) — reads, adds,
// writes back every time rather than batching, same tradeoff already made
// for the exploration graph design: the file is small and local, so
// per-call I/O costs nothing next to the network round trip that produced
// the usage numbers in the first place.
export function recordUsage(
	model: string,
	inputTokens: number,
	outputTokens: number,
): void {
	const current = readGlobalUsage();
	const existing = current.byModel[model] ?? {
		inputTokens: 0,
		outputTokens: 0,
	};

	writeGlobalUsage({
		byModel: {
			...current.byModel,
			[model]: {
				inputTokens: existing.inputTokens + inputTokens,
				outputTokens: existing.outputTokens + outputTokens,
			},
		},
		// The first-ever recording is what actually starts the clock — a
		// still-null since here means no file existed before this call.
		since: current.since ?? new Date().toISOString(),
	});
}

export function resetGlobalUsage(): void {
	writeGlobalUsage({byModel: {}, since: new Date().toISOString()});
}

export function totalTokens(usage: UsageStats): ModelUsage {
	return Object.values(usage.byModel).reduce(
		(total, entry) => ({
			inputTokens: total.inputTokens + entry.inputTokens,
			outputTokens: total.outputTokens + entry.outputTokens,
		}),
		{inputTokens: 0, outputTokens: 0},
	);
}

// USD per 1,000,000 tokens, sourced from OpenAI's own pricing page at the
// time each model was wired into this codebase — this codebase has no way
// to fetch current rates itself, so these are point-in-time snapshots that
// WILL go stale if pricing changes, or silently wrong for any model typed
// into /config that isn't one of the three actually evaluated so far.
// gpt-5.6-luna's long-context tier (2x input / 1.5x output past 272K input
// tokens) isn't modeled — a single turn's input for this codebase hasn't
// approached that threshold in practice, so the short-context rate is the
// right default; revisit if that changes.
const MODEL_PRICING_PER_MILLION_TOKENS_USD: Record<
	string,
	{input: number; output: number}
> = {
	'gpt-5.6-luna': {input: 0.2, output: 1.2},
	'gpt-5.4-nano': {input: 0.2, output: 1.25},
	'gpt-5.2': {input: 1.75, output: 14},
};

export type CostEstimate = {
	totalUsd: number;
	// Models with recorded usage but no entry in the pricing table above —
	// e.g. something hand-typed into /config that was never added here.
	// Their tokens are excluded from totalUsd rather than guessed at any
	// other model's rate, so the estimate stays an underestimate (visible
	// and honest) instead of a plausible-looking wrong number.
	unpricedModels: string[];
};

export function estimateCostUsd(usage: UsageStats): CostEstimate {
	let totalUsd = 0;
	const unpricedModels: string[] = [];

	for (const [model, tokens] of Object.entries(usage.byModel)) {
		const pricing = MODEL_PRICING_PER_MILLION_TOKENS_USD[model];
		if (!pricing) {
			if (tokens.inputTokens > 0 || tokens.outputTokens > 0) {
				unpricedModels.push(model);
			}
			continue;
		}

		totalUsd +=
			(tokens.inputTokens / 1_000_000) * pricing.input +
			(tokens.outputTokens / 1_000_000) * pricing.output;
	}

	return {totalUsd, unpricedModels};
}
