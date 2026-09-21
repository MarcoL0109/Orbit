import type {AgentStep} from './agentLoop.js';
import type {ApiCall} from './browserWorker.js';
import {choice, type SystemOneClient} from './jevClient.js';
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
// candidates in one batch (MAX_CAPTURED_PER_ACTION caps that batch at 10,
// but candidates surviving collectSeedableRequestsThisRun's click
// correlation are usually far fewer). Jev's job here is only to PICK the
// right candidate, not to hold the byte-exact body — the written test still
// replays the original, untruncated capture from collectSeedableRequestsThisRun,
// never anything reconstructed from what Jev was shown.
const CANDIDATE_PREVIEW_CHARS = 1500;

const NONE_LABEL = 'none';

function candidateLabel(index: number): string {
	return `call_${index}`;
}

export type SeedRequestRefinement =
	// Jev picked a specific candidate, or explicitly said none of them
	// qualify — either way, confidence is Jev's own calibrated probability
	// for that answer, not a guess.
	| {source: 'jev'; pick: ApiCall | null; confidence: number}
	// Jev was never consulted (0 or 1 candidates — nothing to disambiguate)
	// or the call failed/errored — the mechanical filter's own ordering is
	// still a usable, if less precise, answer. Never let a Jev failure
	// block seeding entirely: "AI-assisted, not AI-dependent."
	| {source: 'fallback'; pick: ApiCall | null};

// Refines collectSeedableRequestsThisRun's own output — never a substitute
// for it. Candidates in, at most one of them (or null) out.
export async function seedRequestJev(
	candidates: ApiCall[],
	jevClient: SystemOneClient,
): Promise<SeedRequestRefinement> {
	if (candidates.length === 0) {
		return {source: 'fallback', pick: null};
	}

	// Nothing to disambiguate — nothing Jev could add over the mechanical
	// filter's own single answer, so skip the call entirely.
	if (candidates.length === 1) {
		return {source: 'fallback', pick: candidates[0]!};
	}

	// Deliberately NOT scoped to "creation" specifically — a precondition
	// isn't always "an existing record," it can just as easily be "an
	// existing record in a particular STATE": a confirmed order to cancel,
	// a deleted item to restore, an archived record to reactivate. The
	// request that establishes any of those is an update/state-transition
	// or delete call, not a create — asking Jev to find only a "creation"
	// would actively steer it away from picking those. The real dividing
	// line this needs to draw is "a genuine server-side mutation" versus
	// "read-only or unrelated traffic that happened to fire alongside it"
	// — which specific KIND of mutation actually matches what this test's
	// precondition needs is left to the agent itself, which has that
	// context and the full untruncated body; Jev's only job is separating
	// real mutations from noise.
	const criteria: Record<string, string> = {
		[NONE_LABEL]:
			'None of the candidates is a genuine state-mutating request (creating, updating, confirming, deleting, or otherwise persisting a change) — every one is unrelated traffic that happened to fire alongside the same click (a search, a view/onchange preview, a bootstrap or messaging call), not an actual mutation.',
	};

	candidates.forEach((call, index) => {
		criteria[
			candidateLabel(index)
		] = `The candidate at this index (${call.method} ${call.url}) is a genuine state-mutating request — one that actually creates, updates, confirms, deletes, or otherwise persists a change on the server, as opposed to a read, a search, a preview, or unrelated background traffic.`;
	});

	try {
		const {answers} = await jevClient.systemOne({
			state: {
				instructions:
					'These API requests were all captured during a single UI click in a live web app test — one real user action, several network calls it happened to trigger. Identify which ONE, if any, actually mutates server-side state (creates, updates, confirms, deletes, or otherwise persists a change), as opposed to a search, a form-preview/onchange call, or unrelated background traffic (messaging, notifications, view metadata) that just happened to fire during the same click.',
				candidates: candidates.map((call, index) => ({
					id: candidateLabel(index),
					method: call.method,
					url: call.url,
					requestBodyPreview:
						call.requestBody?.slice(0, CANDIDATE_PREVIEW_CHARS) ?? null,
				})),
			},
			questions: {
				seedable_request: choice(
					'Which candidate (by id), if any, is a genuine state-mutating request safe to replay as a test precondition?',
					criteria,
				),
			},
		});

		const answer = answers['seedable_request'];
		if (!answer) {
			return {source: 'fallback', pick: candidates[0]!};
		}

		if (answer.choice === NONE_LABEL) {
			return {source: 'jev', pick: null, confidence: answer.confidence};
		}

		const index = candidates.findIndex(
			(_, candidateIndex) => candidateLabel(candidateIndex) === answer.choice,
		);
		const pick = index === -1 ? null : candidates[index]!;

		// A choice label Jev returned that doesn't map back to a real
		// candidate index is a contract mismatch, not a real "none" answer
		// — treat it the same as an unreachable Jev rather than trust a
		// pick that doesn't actually resolve to anything.
		return pick
			? {source: 'jev', pick, confidence: answer.confidence}
			: {source: 'fallback', pick: candidates[0]!};
	} catch {
		return {source: 'fallback', pick: candidates[0]!};
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

// What agent.ts's buildSystemPrompt actually shows the model every turn —
// mechanical list unchanged when Jev isn't configured, unavailable, or has
// nothing to disambiguate (source: 'fallback'); Jev's own pick surfaced
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

	const confidencePercent = Math.round(refinement.confidence * 100);

	if (refinement.pick === null) {
		return `Jev reviewed the ${candidates.length} candidates below and found none of them a genuine state-mutating request (${confidencePercent}% confidence) — do not seed from any of these for this precondition.\n\n${mechanicalList}`;
	}

	return `Jev's pick out of the ${candidates.length} candidates below, as the one most likely to be a genuine state-mutating request (${confidencePercent}% confidence) — confirm it actually matches the specific precondition state this feature needs (e.g. created vs. confirmed vs. deleted) before seeding from it, since Jev only separates real mutations from unrelated traffic, not which mutation this test specifically needs:
- ${refinement.pick.method} ${refinement.pick.url}
  body: ${refinement.pick.requestBody}

All candidates, for reference:
${mechanicalList}`;
}
