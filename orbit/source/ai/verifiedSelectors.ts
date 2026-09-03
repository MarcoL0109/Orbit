import type {AgentStep} from './agentLoop.js';

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
	const namePropertyPattern = /name:\s*['"]([^'"]+)['"]/g;
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
