import type {AgentStep} from './agentLoop.js';
import type {ApiCall} from './browserWorker.js';
import {noul, type SystemOneClient} from './jevClient.js';
import {
	collectSeedableRequestsThisRun,
	summarizeSeedableRequests,
} from './verifiedSelectors.js';

// Deliberately its own module, not folded into verifiedSelectors.ts (see
// collectSeedableRequestsThisRun there). That function stays a small, pure,
// synchronous, dependency-free filter — it's also the fallback whenever this
// one can't run — while this module owns everything that actually talks to
// the network: building the request, calling Jev, and falling back safely
// on any failure. Mixing the two would leave no clean fallback to fall back
// to.

// Kept well under Jev's 32K state character limit even with several
// candidates across a run (MAX_CAPTURED_PER_ACTION caps each individual
// batch at 10, but collectSeedableRequestsThisRun dedupes by endpoint across
// the whole run, so the total is usually far fewer than that times however
// many commit-clicks happened). Jev's job here is only to say yes/no on
// each one, not to hold the byte-exact body — the written test still
// replays the original, untruncated capture from collectSeedableRequestsThisRun,
// never anything reconstructed from what Jev was shown.
const CANDIDATE_PREVIEW_CHARS = 1500;

function candidateLabel(index: number): string {
	return `call_${index}`;
}

export type SeedRequestRefinement =
	// Jev looked at every candidate independently and said which ones are
	// genuine mutations — zero, one, or several can survive; this is a
	// filter, not a pick-one selector. Two real, distinct establishing
	// actions in the same run (e.g. a create AND a separate confirm) are
	// both genuine and both belong in the result — forcing a single winner
	// between them would be wrong, not just imprecise.
	| {source: 'jev'; genuine: ApiCall[]}
	// Jev was never consulted (0 or 1 candidates — nothing to filter) or the
	// call failed/errored — the mechanical filter's own candidates are still
	// a usable, if noisier, answer. Never let a Jev failure block seeding
	// entirely: "AI-assisted, not AI-dependent." All candidates pass through
	// unfiltered here rather than none, for the same reason.
	| {source: 'fallback'; genuine: ApiCall[]};

// Refines collectSeedableRequestsThisRun's own output — never a substitute
// for it. Candidates in, the subset that are genuine mutations out; which
// of those (if any) actually matches what a SPECIFIC precondition needs is
// still left entirely to the model — Jev only separates real mutations from
// noise, it has no idea what any given test file is about.
export async function seedRequestJev(
	candidates: ApiCall[],
	jevClient: SystemOneClient,
): Promise<SeedRequestRefinement> {
	if (candidates.length === 0) {
		return {source: 'fallback', genuine: []};
	}

	// Nothing to filter — a single candidate is either usable or it isn't,
	// and collectSeedableRequestsThisRun's own method/body/truncation
	// filtering already made that call; Jev would add nothing here.
	if (candidates.length === 1) {
		return {source: 'fallback', genuine: candidates};
	}

	// One independent yes/no question per candidate, asked in a single
	// request (Questions can hold any number of named entries) — not one
	// choice question forced to pick a single winner. Deliberately NOT
	// scoped to "creation" specifically — a precondition isn't always "an
	// existing record," it can just as easily be "an existing record in a
	// particular STATE": a confirmed order to cancel, a deleted item to
	// restore, an archived record to reactivate. The request that
	// establishes any of those is an update/state-transition or delete
	// call, not a create — asking only about "creation" would actively
	// steer Jev away from a real confirm/update/delete candidate sitting
	// right next to a real create one. The real dividing line is "a genuine
	// server-side mutation" versus "read-only or unrelated traffic that
	// happened to fire alongside it."
	const questions: Record<string, ReturnType<typeof noul>> = {};
	candidates.forEach((call, index) => {
		questions[candidateLabel(index)] = noul(
			`This request was captured during a live test-writing run, behind a click that looked like it commits a change (save/submit/create/confirm). Is it a genuine state-mutating request — one that actually creates, updates, confirms, deletes, or otherwise persists a change on the server — as opposed to a read, a search, a form-preview/onchange call, or unrelated background traffic (messaging, notifications, view metadata) that just happened to fire around the same click?\n\n${
				call.method
			} ${call.url}\nbody: ${
				call.requestBody?.slice(0, CANDIDATE_PREVIEW_CHARS) ?? '(none)'
			}`,
			{
				true: 'A genuine mutation — safe to consider replaying as a test precondition.',
				false:
					'Not a mutation — a read, search, preview, or unrelated background traffic.',
			},
		);
	});

	try {
		const {answers} = await jevClient.systemOne({
			state:
				'Each question below is its own independent captured API request from the same test-writing run — judge each on its own, not relative to the others.',
			questions,
		});

		const genuine = candidates.filter((_, index) => {
			const answer = answers[candidateLabel(index)];
			// A missing answer (a partial/malformed response) is treated as
			// "keep" rather than "drop" — Jev failing to answer is not the
			// same as Jev answering no, and losing a real candidate to an
			// ambiguous non-answer is a worse outcome than showing one extra
			// candidate the model has to look at itself.
			return (answer?.noul ?? 1) >= 0.5;
		});

		return {source: 'jev', genuine};
	} catch {
		return {source: 'fallback', genuine: candidates};
	}
}

// Candidates only ever grow or hold steady turn to turn (see
// collectSeedableRequestsThisRun's own dedup) — several turns in a row with
// no new browser_action capture (e.g. a run of write_test_file repairs)
// would otherwise re-ask Jev the exact same question, and re-report the
// exact same outcome, every single turn until a write finally happens.
// Keyed by the candidate set itself, not by turn count, so a genuinely new
// capture still triggers a fresh consultation immediately.
export type SeedRefinementCache = {
	current: {candidateKey: string; refinement: SeedRequestRefinement} | null;
};

function candidateSetKey(candidates: ApiCall[]): string {
	return candidates
		.map(call => `${call.method} ${call.url}`)
		.sort()
		.join('|');
}

// Used by write_test_file's own seeding gate — reads whatever
// summarizeSeedableRequestsWithJev already computed for THIS turn out of the
// same cache, rather than triggering a second live Jev call of its own (that
// call is async and this needs to be safe to call synchronously from inside
// a tool's execute()). Falls back to the raw, unfiltered candidate list
// whenever Jev hasn't filtered the CURRENT exact candidate set — no
// TYPESAFE_API_KEY configured, Jev unreachable, or new captures arrived
// since the cached refinement was computed — so the gate is never worse off
// than checking collectSeedableRequestsThisRun directly, only more precise
// (fewer false positives on a POST-tunneled read that merely has a JSON
// body) when a matching filtered result actually exists.
export function seedableCandidatesForGate(
	steps: AgentStep[],
	cache: SeedRefinementCache,
): ApiCall[] {
	const candidates = collectSeedableRequestsThisRun(steps);
	if (candidates.length === 0) {
		return candidates;
	}

	const current = cache.current;
	if (
		current &&
		current.candidateKey === candidateSetKey(candidates) &&
		current.refinement.source === 'jev'
	) {
		return current.refinement.genuine;
	}

	return candidates;
}

// What agent.ts's buildSystemPrompt actually shows the model every turn —
// mechanical list unchanged when Jev isn't configured, unavailable, or has
// nothing to filter (source: 'fallback'); Jev's own filtered set surfaced
// first, ahead of that same list kept for reference/fallback visibility,
// whenever Jev actually answered. jevClient is null for any project with no
// TYPESAFE_API_KEY set — Jev is an optional enhancement, never a
// requirement to seed at all (collectSeedableRequestsThisRun's own output is
// always usable on its own). onConsulted fires only on a genuine cache miss
// — a real new call to Jev (or a real new fallback decision) — never on a
// reused cached result, so a caller reporting this to the user (agent.ts
// does) shows one line per real event, not one per turn.
export async function summarizeSeedableRequestsWithJev(
	steps: AgentStep[],
	jevClient: SystemOneClient | null,
	cache: SeedRefinementCache,
	onConsulted?: (
		refinement: SeedRequestRefinement,
		candidateCount: number,
	) => void,
): Promise<string> {
	const mechanicalList = summarizeSeedableRequests(steps);

	if (!jevClient) {
		return mechanicalList;
	}

	const candidates = collectSeedableRequestsThisRun(steps);
	if (candidates.length <= 1) {
		return mechanicalList;
	}

	const candidateKey = candidateSetKey(candidates);
	let refinement: SeedRequestRefinement;

	if (cache.current && cache.current.candidateKey === candidateKey) {
		refinement = cache.current.refinement;
	} else {
		refinement = await seedRequestJev(candidates, jevClient);
		cache.current = {candidateKey, refinement};
		onConsulted?.(refinement, candidates.length);
	}

	if (refinement.source !== 'jev') {
		return mechanicalList;
	}

	const excludedCount = candidates.length - refinement.genuine.length;

	if (refinement.genuine.length === 0) {
		return `Jev reviewed the ${candidates.length} candidates below and found none of them a genuine state-mutating request — do not seed from any of these for this precondition.\n\n${mechanicalList}`;
	}

	const genuineList = refinement.genuine
		.map(call => `- ${call.method} ${call.url}\n  body: ${call.requestBody}`)
		.join('\n');

	return `Jev reviewed the ${candidates.length} candidates below and kept ${refinement.genuine.length} as genuine state-mutating requests (excluded ${excludedCount} as reads/previews/unrelated traffic). Which of these (if any) actually matches the specific precondition state THIS feature needs (e.g. created vs. confirmed vs. deleted) is still your own call — Jev only separates real mutations from noise, not which mutation a given test needs:
${genuineList}

All candidates, for reference:
${mechanicalList}`;
}
