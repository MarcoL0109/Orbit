import type {AgentStep} from './agentLoop.js';
import type {ApiCall, BrowserWorkerResponse} from './browserWorker.js';

export type VerifiedBrowserAction =
	| {
			action: 'click' | 'selectOption' | 'hover';
			selector: string;
			value: string | null;
			frame: string | null;
	  }
	| {
			action: 'fill';
			selector: string;
			value: string | null;
			frame: string | null;
	  }
	| {
			action: 'press';
			selector: string | null;
			key: string;
			frame: string | null;
	  }
	| {
			action: 'wait';
			selector: string;
			state: 'visible' | 'hidden';
			frame: string | null;
	  };

// Pulled straight from this run's own browser_action call log — the exact
// selector strings already confirmed to work against the real, live page,
// not a description of them. write_test_file takes free-form content the
// model composes itself; nothing forces it to reuse a selector it already
// verified rather than reconstructing a similar-looking one from memory of
// general Playwright/framework conventions, and those two don't always
// match (a selector that resolved uniquely in the exact moment it was
// clicked live isn't guaranteed to be the one the model recalls when
// writing the file afterward). Surfacing the verified list explicitly, every
// turn (see agent.ts's buildSystemPrompt), was the first half of closing
// that gap; findUnverifiedNames below (used by write_test_file directly, in
// blind mode) is the second, enforced half — see its own comment.
// click/fill/selectOption/press/hover/wait only: navigate/snapshot/reset
// have no selector (or key/state) worth reusing.
export function collectVerifiedSelectorsThisRun(
	steps: AgentStep[],
): VerifiedBrowserAction[] {
	const verified: VerifiedBrowserAction[] = [];

	for (let index = 0; index < steps.length - 1; index++) {
		const call = steps[index];
		const result = steps[index + 1];

		if (
			call?.type !== 'tool_call' ||
			call.name !== 'browser_action' ||
			result?.type !== 'tool_result' ||
			result.name !== 'browser_action' ||
			!result.result.ok
		) {
			continue;
		}

		const args = call.args as {
			action?: string;
			selector?: string | null;
			value?: string | null;
			key?: string | null;
			frame?: string | null;
		};

		if (
			(args.action === 'click' ||
				args.action === 'selectOption' ||
				args.action === 'hover') &&
			args.selector
		) {
			verified.push({
				action: args.action,
				selector: args.selector,
				value: args.value ?? null,
				frame: args.frame ?? null,
			});
		} else if (args.action === 'fill' && args.selector) {
			verified.push({
				action: 'fill',
				selector: args.selector,
				value: args.value ?? null,
				frame: args.frame ?? null,
			});
		} else if (args.action === 'press' && args.key) {
			verified.push({
				action: 'press',
				selector: args.selector ?? null,
				key: args.key,
				frame: args.frame ?? null,
			});
		} else if (
			args.action === 'wait' &&
			args.selector &&
			(args.value === 'visible' || args.value === 'hidden')
		) {
			verified.push({
				action: 'wait',
				selector: args.selector,
				state: args.value,
				frame: args.frame ?? null,
			});
		}
	}

	return verified;
}

export function summarizeVerifiedSelectors(steps: AgentStep[]): string {
	const verified = collectVerifiedSelectorsThisRun(steps);

	if (verified.length === 0) {
		return 'None yet this run.';
	}

	return verified
		.map(entry => {
			const inFrame = entry.frame ? ` inside frame ${entry.frame}` : '';

			switch (entry.action) {
				case 'click':
					return `- click: ${entry.selector}${inFrame}`;
				case 'hover':
					return `- hover: ${entry.selector}${inFrame}`;
				case 'fill':
					return `- fill: ${entry.selector} = ${JSON.stringify(
						entry.value,
					)}${inFrame}`;
				case 'selectOption':
					return `- selectOption: ${entry.selector} = ${JSON.stringify(
						entry.value,
					)}${inFrame}`;
				case 'press':
					return entry.selector
						? `- press: "${entry.key}" on ${entry.selector}${inFrame}`
						: `- press: "${entry.key}" (global, no element focused)${inFrame}`;
				case 'wait':
					return `- wait: ${entry.selector} until ${entry.state}${inFrame}`;
			}
		})
		.join('\n');
}

// Every successful, state-changing (non-GET, with a body) API call this
// run's own live exploration actually captured — the same raw material the
// seeding technique in agent.ts's system prompt reuses. This exists for the
// same reason summarizeVerifiedSelectors above does: a technique described
// only in prose, competing every turn against a MECHANICALLY-enforced
// default (write_test_file's blind-mode gate only ever guarantees a pass
// for selectors that trace back to something literally clicked/filled live
// — replaying the UI flow verbatim is the one path the model can be
// certain survives that gate), consistently lost to that default even
// after the prose was made more directive — confirmed directly, twice, on
// the same feature. An equally concrete, itemized artifact to copy a seed
// call from, surfaced every turn right alongside the selector list, is the
// structural fix; a paragraph competing against a list is not a fair fight
// no matter how forcefully the paragraph is worded.
//
// "Non-GET with a body" alone is nowhere near precise enough a filter,
// confirmed directly: a real capture batch against a real app (Odoo) had
// TEN qualifying POST calls for every one genuine creation request — view
// definitions, search reads, onchange previews, systray/messaging
// bootstrap calls — because that app (like many real JSON-RPC/GraphQL
// backends) tunnels every RPC call, reads included, through POST to the
// same endpoint shape. Buried 9th out of 10 in that list, the real
// creation request was there, but the model reported none had been
// captured — not dishonest, just an unusable, noise-drowned list. Every
// captured batch is already scoped to ONE browser_action (apiCalls is
// drained per-action, not accumulated), so correlating with what TRIGGERED
// that action is a much stronger, still app-agnostic signal than the HTTP
// method: a real save/create/confirm is overwhelmingly a click on a
// button whose accessible name says so, not a page load, a fill, or a
// mid-form selection.
const COMMIT_LIKE_SELECTOR_PATTERN = /save|submit|create|confirm/i;

function wasTriggeredByCommitClick(
	steps: AgentStep[],
	resultIndex: number,
): boolean {
	const triggeringCall = steps[resultIndex - 1];
	if (
		triggeringCall?.type !== 'tool_call' ||
		triggeringCall.name !== 'browser_action'
	) {
		return false;
	}

	const args = triggeringCall.args as {
		action?: string;
		selector?: string | null;
	};
	return (
		args.action === 'click' &&
		!!args.selector &&
		COMMIT_LIKE_SELECTOR_PATTERN.test(args.selector)
	);
}

// Keyed by "METHOD url" so a repeated call against the same endpoint (e.g.
// a retry during repair) keeps only its most recent capture, not every
// attempt.
export function collectSeedableRequestsThisRun(steps: AgentStep[]): ApiCall[] {
	const seedable = new Map<string, ApiCall>();

	for (const [index, step] of steps.entries()) {
		if (
			step.type !== 'tool_result' ||
			step.name !== 'browser_action' ||
			!step.result.ok ||
			!wasTriggeredByCommitClick(steps, index)
		) {
			continue;
		}

		const data = step.result.data as BrowserWorkerResponse & {ok: true};
		for (const call of data.apiCalls ?? []) {
			if (
				!call.ok ||
				call.method === 'GET' ||
				!call.requestBody ||
				call.requestBodyTruncated
			) {
				continue;
			}
			seedable.set(`${call.method} ${call.url}`, call);
		}
	}

	return [...seedable.values()];
}

// Distinguishes "nothing to seed from" from "something was captured but
// excluded" — without this, a truncated capture (see
// MAX_CAPTURED_REQUEST_BODY_CHARS in browserWorker.ts) looks IDENTICAL to
// genuine unavailability in the prompt, which is exactly the ambiguity that
// made a real instance of this bug look, from the outside, like the model
// simply wasn't trying.
function hasTruncatedSeedCandidate(steps: AgentStep[]): boolean {
	for (const [index, step] of steps.entries()) {
		if (
			step.type !== 'tool_result' ||
			step.name !== 'browser_action' ||
			!step.result.ok ||
			!wasTriggeredByCommitClick(steps, index)
		) {
			continue;
		}

		const data = step.result.data as BrowserWorkerResponse & {ok: true};
		for (const call of data.apiCalls ?? []) {
			if (
				call.ok &&
				call.method !== 'GET' &&
				call.requestBody &&
				call.requestBodyTruncated
			) {
				return true;
			}
		}
	}

	return false;
}

export function summarizeSeedableRequests(steps: AgentStep[]): string {
	const seedable = collectSeedableRequestsThisRun(steps);

	if (seedable.length === 0) {
		return hasTruncatedSeedCandidate(steps)
			? 'None usable — a real creation request was captured this run, but its body was too long and got truncated (see requestBodyTruncated), so it is NOT safe to replay verbatim. Do not seed from it; use the full UI flow for this precondition instead.'
			: 'None captured yet this run.';
	}

	return seedable
		.map(call => {
			const contentType = call.requestContentType
				? ` (content-type: ${call.requestContentType})`
				: '';
			return `- ${call.method} ${call.url}${contentType}\n  body: ${call.requestBody}`;
		})
		.join('\n');
}

// Extracts the quoted "name" string from each verified selector, where
// present — Playwright's own selector-engine syntax (e.g.
// `role=combobox[name="Type to find a customer..."]`), the format
// browser_action's `selector` argument uses. Selectors with no name
// portion (bare CSS, text=, etc.) contribute nothing to the comparison —
// an acceptable, deliberate gap given how consistently role-based
// selectors are used elsewhere in this codebase already.
function extractVerifiedNames(actions: VerifiedBrowserAction[]): string[] {
	const names: string[] = [];

	for (const action of actions) {
		if (!action.selector) continue;
		const match = /name="([^"]*)"/.exec(action.selector);
		if (match) names.push(match[1]!);
	}

	return names;
}

// Names referenced via an interactive-role locator anywhere in the written
// file content — getByRole's own `name:` option (string literals only; a
// regex pattern like /RCQ-\d+/ is for matching generated/dynamic content,
// never something a live selector could "verify" in the first place) plus
// getByLabel/getByPlaceholder/getByText's direct string argument.
function extractReferencedNames(fileContent: string): string[] {
	const names: string[] = [];
	// Anchored to an actual getByRole(...) call, not a bare `name:` anywhere
	// in the file — a written test can now also contain a raw JSON payload
	// (a seeded API request's body, see agent.ts's seeding guidance), and an
	// unanchored pattern matches ANY object key ending in "name:", including
	// as the tail of an unrelated key like `x_studio_project_name`. Confirmed
	// directly: a seed call's own payload field tripped this exact false
	// positive, which would have blindly rejected a correct, already-live-
	// verified seed request as an unverified selector. [^)]*? assumes
	// getByRole's own two-arg call isn't itself broken across a `)` — true
	// for every real getByRole usage, which never nests another call's
	// closing paren between the role string and its options object.
	const namePropertyPattern = /getByRole\([^)]*?name:\s*['"]([^'"]+)['"]/g;
	const directArgPattern =
		/getBy(?:Label|Placeholder|Text)\(\s*['"]([^'"]+)['"]/g;

	for (const match of fileContent.matchAll(namePropertyPattern)) {
		names.push(match[1]!);
	}

	for (const match of fileContent.matchAll(directArgPattern)) {
		names.push(match[1]!);
	}

	return names;
}

// Lenient on purpose (substring either direction, case-insensitive) —
// browser_action's captured name and whatever the model later types into
// the file can differ in trivial ways (an ellipsis, trailing punctuation)
// without that meaning the model actually made the selector up. The goal
// is catching "this name traces back to nothing touched live this run",
// not byte-exact reproduction.
function namesMatch(a: string, b: string): boolean {
	const normalizedA = a.trim().toLowerCase();
	const normalizedB = b.trim().toLowerCase();
	return normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA);
}

// Blind-mode-only check (see write_test_file, the only caller) — returns
// every name referenced in the file that has no matching verified action
// this run, i.e. names the model could only have gotten from something
// other than actually touching the real page this run (a stale test file,
// the exploration graph's own "hint, not ground truth" summary, general
// assumptions about how this kind of app usually works). An empty array
// means every referenced name traces back to something genuinely
// confirmed live this run — including the specific case that motivated
// this: a run with zero browser_action calls at all makes every single
// referenced name unverified, since there's nothing to match against.
export function findUnverifiedNames(
	fileContent: string,
	steps: AgentStep[],
): string[] {
	const verifiedNames = extractVerifiedNames(
		collectVerifiedSelectorsThisRun(steps),
	);
	const referencedNames = [...new Set(extractReferencedNames(fileContent))];

	return referencedNames.filter(
		referenced =>
			!verifiedNames.some(verified => namesMatch(referenced, verified)),
	);
}
