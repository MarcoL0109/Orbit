import fs from 'node:fs';
import path from 'node:path';
import type {ResponseInputItem} from 'openai/resources/responses/responses';
import {graphifyGraphExists} from '../projects/graphifyGraph.js';
import {readProjectMap, type ProjectMap} from '../projects/scan.js';
import {readProjectMemory, type ProjectMemory} from '../init/memory.js';
import {recordUsage} from '../registry/usage.js';
import {
	readExplorationGraph,
	summarizeExplorationGraph,
} from './explorationGraph.js';
import {readFeatureClassifications} from '../projects/featureClassification.js';
import {checksumFromContent} from '../projects/checksum.js';
import {createOpenAIClient, type ResponsesClient} from './client.js';
import {
	toolRegistry,
	explainSymbolTool,
	type ToolContext,
	type ToolDefinition,
	type ToolResult,
} from './tools/index.js';
import {spawnBrowserWorker, type BrowserWorkerHandle} from './browserWorker.js';
import {
	runAgentTurn,
	type AgentStep,
	type AgentProgressEvent,
	type AgentTurnResult,
} from './agentLoop.js';
import type {
	ReportResultArgs,
	FeatureResult,
	FeatureResultInput,
} from './tools/reportResult.js';
import type {
	RunTestResult,
	TestOutcome,
	TestStatus,
	TestFailureDetail,
} from './tools/runTest.js';

export type {ResponsesClient} from './client.js';
export type {AgentStep, AgentProgressEvent} from './agentLoop.js';

export type AgentRunResult = {
	status: 'passed' | 'failed' | 'gave_up' | 'aborted';
	summary: string;
	results: FeatureResult[];
	steps: AgentStep[];
};

const ACTIVITY_LABEL: Record<string, string> = {
	read_file: 'Reading project files...',
	write_test_file: 'Writing the test file...',
	run_test: 'Running the test...',
	report_result: 'Wrapping up...',
	browser_action: 'Exploring the page...',
	request_user_input: 'Waiting for input...',
	explain_symbol: 'Checking the code graph...',
	confirm_outcome: 'Waiting for your judgment...',
};

export function describeAgentActivity(event: AgentProgressEvent): string {
	return ACTIVITY_LABEL[event.name] ?? `Running ${event.name}...`;
}

// The other half of describeAgentActivity: not "what is it about to do" but
// "what actually happened" — shown once a step's tool_result comes back, so
// a step-by-step log reads as a sequence of (started X, X's outcome) pairs
// rather than just a list of things that were attempted. Per-tool cases pull
// the one detail worth surfacing from that tool's own args/result shape;
// everything else falls back to a generic pass/fail line.
export function describeAgentStepOutcome(
	name: string,
	args: unknown,
	result: ToolResult,
): string {
	if (!result.ok) {
		const label = ACTIVITY_LABEL[name]?.replace(/\.{3}$/, '') ?? name;
		return `✗ ${label} — ${result.error}`;
	}

	switch (name) {
		case 'read_file': {
			const {path: filePath} = args as {path?: string};
			return `✓ Read ${filePath ?? 'file'}`;
		}

		case 'write_test_file': {
			const {relativePath} = args as {relativePath?: string};
			return `✓ Wrote ${relativePath ?? 'test file'}`;
		}

		case 'run_test': {
			const {passed, passedCount, totalTests} = result.data as {
				passed?: boolean;
				passedCount?: number;
				totalTests?: number;
			};
			return typeof passedCount === 'number' && typeof totalTests === 'number'
				? `${passed ? '✓' : '✗'} Test run: ${passedCount}/${totalTests} passed`
				: '✓ Test run finished';
		}

		case 'explain_symbol': {
			const {label} = args as {label?: string};
			return `✓ Looked up ${label ?? 'symbol'}`;
		}

		case 'browser_action': {
			const {action} = args as {action?: string};
			return `✓ Browser: ${action ?? 'action'}`;
		}

		case 'report_result': {
			return '✓ Reported results';
		}

		case 'confirm_outcome': {
			return '✓ Got outcome confirmation';
		}

		case 'request_user_input': {
			return '✓ Got user input';
		}

		default: {
			return `✓ ${name}`;
		}
	}
}

export type RunTestingAgentOptions = {
	maxSteps?: number;
	client?: ResponsesClient;
	onProgress?: (event: AgentProgressEvent) => void;
	// Fires once a dispatched tool call's result comes back — separate from
	// onProgress (which fires at dispatch time, before the result exists) so
	// a caller can show "started X" and "X's outcome" as two distinct,
	// appendable lines rather than one line that gets overwritten.
	onStepResult?: (name: string, args: unknown, result: ToolResult) => void;
};

const MAX_LISTED_ITEMS = 50;

function formatList(items: string[]): string {
	if (items.length === 0) return 'None detected';
	const shown = items.slice(0, MAX_LISTED_ITEMS);
	const remainder = items.length - shown.length;
	return shown.join('\n') + (remainder > 0 ? `\n...and ${remainder} more` : '');
}

// Files this run has already written, read straight from the loop's own
// `steps` — no rescan, no hash, no freshness check needed. The run just
// did this itself, moments ago; there's nothing to verify.
function collectTestsWrittenThisRun(
	steps: AgentStep[],
	projectRoot: string,
): string[] {
	const files = new Set<string>();

	for (const step of steps) {
		if (
			step.type === 'tool_result' &&
			step.name === 'write_test_file' &&
			step.result.ok
		) {
			const data = step.result.data as {path: string};
			files.add(path.relative(projectRoot, data.path));
		}
	}

	return [...files];
}

type VerifiedBrowserAction =
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
// turn, is what actually closes that gap — see buildSystemPrompt below.
// click/fill/selectOption/press/hover/wait only: navigate/snapshot/reset
// have no selector (or key/state) worth reusing.
function collectVerifiedSelectorsThisRun(
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

function summarizeVerifiedSelectors(steps: AgentStep[]): string {
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

// Reuses whatever /scan already computed instead of leaving the model to
// guess file paths blind — read_file still exists for the actual deep dive
// once it knows which file is relevant. extraTestFiles covers the one gap
// the last /scan can't: test files this run has itself written since that
// scan ran, which won't be in projectMap yet.
export function summarizeProjectMap(
	projectMap: ProjectMap | null,
	extraTestFiles: string[],
	isBlind = false,
): string {
	if (!projectMap) {
		return isBlind
			? 'No project index — this is a blind-mode project with no local source at all. There is nothing to scan and nothing to read; ground everything in what browser_action actually shows you.'
			: 'No project index available yet (run /scan first for a list of known routes and components) — you will need to find files by informed guesswork.';
	}

	const routes = projectMap.routes.map(
		route => `- ${route.route} -> ${route.file}`,
	);
	const components = projectMap.components.map(
		component => `- ${component.name} -> ${component.file}`,
	);

	const knownTestFiles = new Set(projectMap.tests.map(test => test.file));
	const tests = [
		...projectMap.tests.map(test => `- ${test.file}`),
		...extraTestFiles
			.filter(file => !knownTestFiles.has(file))
			.map(file => `- ${file} (written this run)`),
	];

	return `Known project structure (from the last /scan, ${
		projectMap.generatedAt
	}):

Routes:
${formatList(routes)}

Components:
${formatList(components)}

Existing tests:
${formatList(tests)}`;
}

// Everything already confirmed by content — from this project's own
// classification cache, built up as a side effect of past read_file and
// write_test_file calls — grouped by feature so the model can go straight
// to a known file instead of re-discovering it by trial and error. Only
// entries still fresh (checksum matches the file's current state) are
// shown; a stale one would just be misleading a wrong lead.
function summarizeKnownClassifications(projectRoot: string): string {
	const classifications = readFeatureClassifications(projectRoot);
	const filesByFeature = new Map<string, string[]>();

	for (const [file, entry] of Object.entries(classifications.entries)) {
		// Checked against the file's actual current content, not
		// checksums.json — that file is only refreshed by a full project
		// scan, which doesn't happen between turns within a run, so it
		// wouldn't know about anything classified earlier THIS run (like a
		// test file write_test_file just wrote). Hashing directly is cheap
		// here since it's only ever the bounded set of already-classified
		// files, not a full-project walk.
		let currentChecksum: string | null = null;

		try {
			currentChecksum = checksumFromContent(
				fs.readFileSync(path.join(projectRoot, file)),
			);
		} catch {
			continue; // File no longer exists or isn't readable — treat as stale
		}

		if (currentChecksum !== entry.checksum) continue;

		for (const feature of entry.features) {
			const files = filesByFeature.get(feature) ?? [];
			files.push(file);
			filesByFeature.set(feature, files);
		}
	}

	if (filesByFeature.size === 0) {
		return 'None yet — nothing has been classified by feature so far.';
	}

	const lines = [...filesByFeature.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([feature, files]) => `- ${feature}: ${files.join(', ')}`);

	return formatList(lines);
}

// Purely additive context — nothing here is enforced in code, it's the
// project's own accumulated notes and conventions, handed to the model as
// background before it writes anything.
// Exported for /memory to reuse — the exact same formatting the agent
// itself reads its project memory through, not a second, possibly
// drifting, copy of the same thing.
export type MemorySections = {
	overview?: boolean;
	decisions?: boolean;
	environment?: boolean;
	failures?: boolean;
};

// Defaults to all three — the agent's own call site never passes a second
// argument, so its behavior is unchanged. /memory passes an explicit
// include set when the user filters by flag.
export function summarizeMemory(
	memory: ProjectMemory,
	include: MemorySections = {overview: true, decisions: true, failures: true},
): string {
	const sections = [
		include.overview &&
			memory.overview &&
			`## Project overview\n${memory.overview}`,
		include.decisions &&
			memory.decisions &&
			`## Testing decisions and conventions\n${memory.decisions}`,
		include.environment &&
			`## Environment setup Instructions\n${memory.enviornment}`,
		include.failures &&
			memory.failures &&
			`## Known failure patterns\n${memory.failures}`,
	].filter(Boolean);

	return sections.length > 0
		? sections.join('\n\n')
		: 'No project memory recorded yet.';
}

function buildSystemPrompt(
	context: ToolContext,
	projectMap: ProjectMap | null,
	memory: ProjectMemory,
	knownClassifications: string,
	testsWrittenThisRun: string[],
	hasExplainSymbol: boolean,
	steps: AgentStep[],
): string {
	return `You are Orbit, an AI QA agent for E2E testing.

Your job: given a description of one or more features to test, write a Playwright test for each feature using the write_test_file tool, then run it using the run_test tool.

If the prompt describes multiple distinct features, group the features according to the cateogories as there maybe sub-features within a single feature. Group those sub-feature in a single test file — do not combine multiple features into a single file. This keeps a repair cheap (you only need to resend the one file you're fixing, not every feature's test code) and keeps a failure in one feature from blocking the others. Use run_test's filePath argument to run and repair one feature's file independently of the others.

${summarizeProjectMap(
	projectMap,
	testsWrittenThisRun,
	context.orbitConfig.blind,
)}

${
	context.orbitConfig.blind
		? "There is no read_file tool in this run and no project index — this is a blind-mode project with no local source at all. Every feature you test has to be discovered and verified entirely through browser_action: navigate, look at what actually rendered, and derive selectors from that, never from memory of how this kind of app 'usually' works.\n"
		: `Files already confirmed by feature (from past runs — read the file directly if what you need is listed here, instead of exploring blind):
${knownClassifications}

Use the project index above to find the right file to read before writing selectors — prefer it over guessing paths. If a feature you're asked to test isn't listed anywhere, use read_file to explore starting from a route or component that seems related.
${
	hasExplainSymbol
		? "\nA code knowledge graph is available for this project (explain_symbol). When you start a NEW feature, before any read_file calls, call explain_symbol on the most relevant entry point — the route or component the project index above points to — to see what it's connected to (other components, API handlers, shared utilities). Use that map to decide what actually needs reading, rather than opening the first plausible file and expanding your understanding one read_file call at a time. Keep doing this as you go, too: call explain_symbol on any further route, component, or function BEFORE your first read_file call on it, every time — this is your default first move for anything you haven't already explored this run, not something to reach for only once you notice you need it. It's far cheaper than opening a file and often tells you everything you need (what it imports, what calls it, where it lives) without a read at all. Only fall back to read_file once you actually need to see the real code — exact markup, prop names, JSX structure, selectors — not just its relationships to the rest of the codebase.\n"
		: ''
}`
}
Project memory (read this before writing anything — avoid repeating documented failure patterns and follow documented conventions):

${
	context.orbitConfig.blind
		? `${summarizeMemory(memory, {
				overview: false,
				decisions: false,
				environment: true,
				failures: true,
		  })}

## Exploration graph (built from live browsing on past runs against this app — a hint, not ground truth; still verify live before trusting an edge, an app can change)
${summarizeExplorationGraph(readExplorationGraph(context.projectRoot))}`
		: summarizeMemory(memory)
}

If a run fails because of a broken selector or similar test-side issue, you may patch that feature's test file and run it again — you have a budget of ${
		context.orbitConfig.maxRepairAttempts
	} repair attempts per feature. If a run fails because of an actual application bug (not a problem with the test itself), do not keep patching it — report that feature as failed instead. This includes a bug you identified during exploration rather than from a run_test failure (see below): still write the test against the intended behavior and run it once, so the failure is backed by a real, reproducible Playwright result rather than only your own read of the page — but do not spend repair attempts on it once that run confirms it, since patching the test cannot fix a bug in the application. Report the feature as failed right away instead.

Telling these apart during live exploration (not a run_test failure) is otherwise genuinely ambiguous — a form that silently doesn't do what you expected looks the same on screen whether your click missed its target or the server errored out. Don't guess: check the browser_action response's apiCalls and consoleErrors fields (present on every response, even when nothing went wrong) before deciding which case you're in.
- An apiCalls entry with a 4xx/5xx status and a real backend error message is direct, decisive evidence of an application bug — stop retrying different inputs or selectors, no UI-side change will fix a server error. Report it as a bug instead.
- A 2xx apiCalls entry is not automatically fine, either — check whether its body actually contains what you expected (e.g. a freshly-created item, a non-empty list). If the request clearly succeeded and returned real data but the DOM snapshot doesn't reflect it, that's a rendering bug: the data existed, the UI failed to show it. This is just as decisive as a failed request — do not chalk it up to your own selector being wrong when the response body already proves the data was there.
- Only when apiCalls is empty, or its contents genuinely match what the DOM shows (e.g. an empty list response and an empty-state UI — that's correct, not a bug), should you treat an unexpected result as your own selector or assumption being wrong and try a different approach before concluding it's the app.

Exploring with a real browser (browser_action): the app runs at ${
		context.orbitConfig.baseUrl
	} — navigate accepts a path relative to that (e.g. "/SignUp") or a full URL. read_file shows you source code, not what actually renders — runtime data, conditional branches, and component-library internals can all make the real page different from what the source suggests. Use browser_action to ground your selectors and expected outcomes in what you actually observe, especially for anything read_file can't tell you: content behind a login, a multi-step flow with no direct URL per step, or a state that only appears after an interaction (a toast, a modal, a cart badge). navigate/click/fill already return the resulting accessibility snapshot whenever the page actually changed — you don't need to separately call snapshot after them. Call snapshot on its own only to re-check the current state without taking a new action. Call reset when you start exploring a NEW feature (fresh cookies/storage) — do not call it between pages within the same feature's flow, since a multi-page journey (e.g. cart -> checkout -> payment) depends on staying in the same browser context throughout. A sequence where a later step only makes sense because of what an earlier step just did — reset a password, then verify you can log in with that new password; sign up, then check the account shows as unactivated — is ONE feature, not two, even if the prompt describes it as a list of things to do in order. Only reset when moving to something genuinely independent of what you just verified, not for every checkpoint within one continuous journey. Keep in mind browser_action shows you what actually happens, not what's supposed to happen — if what you observe contradicts the feature description you were given or a documented convention in project memory, treat that as a possible application bug rather than writing an assertion that simply matches the broken behavior.

If a piece of UI you need genuinely doesn't appear in the accessibility snapshot at all — not "hard to find," but structurally absent — it may be rendered inside an <iframe> (a payment widget, an embedded third-party form, a legacy admin panel bolted on without source access). The top-level snapshot does not descend into an iframe's own document. Use browser_action's \`frame\` argument in that case: pass a locator for the iframe element itself (e.g. role=iframe[name="payment"], or a CSS selector you found via a plain snapshot of the outer page), and \`selector\` then resolves inside that frame instead of the main page. Call "snapshot" with \`frame\` set first to see what's actually inside before acting on it — don't guess at what an iframe contains. Leave \`frame\` null for everything else; most apps have no iframes and this should be rare.

Selectors already confirmed to work this run, from your own successful browser_action click/fill calls against the real live page:
${summarizeVerifiedSelectors(steps)}

When you write_test_file, reuse these exact strings for anything they cover — do not re-derive a similar-looking selector from memory or from a general convention of how this kind of element "usually" works. A selector you already confirmed resolves uniquely on the real page is more trustworthy than one you reconstruct afterward, and the two are not guaranteed to match — reconstructing from memory instead of reusing what you verified is exactly how a past run wrote a selector that hung forever even though the equivalent live click had worked moments earlier. If a step in the test isn't covered by anything in this list, that means you wrote or ran the test without verifying that step live first — go back and verify it with browser_action before writing it, rather than guessing. For an entry marked "inside frame X", write it in the test file as \`page.frameLocator(X).locator(selector)\` — a plain \`page.locator(selector)\` only searches the main page's document and will never find an element that lives inside an iframe, even if the exact same selector string worked live via browser_action's \`frame\` argument.

A live "press" that worked can still be a no-op once written down — verify with wait, not just latency. Pressing Enter to confirm a highlighted autocomplete/dropdown suggestion only works once that suggestion has actually finished loading and become the active one; during YOUR OWN exploration there's real time between one browser_action call and the next (each one's own settle, plus your own reasoning time), which is often enough for that to happen without you noticing it was timing-dependent at all. A written test has none of that gap — click() and press('Enter') run back-to-back with nothing in between — so a press that looked instant and reliable while you were exploring can silently select nothing once it's replayed at full speed. Confirmed live: a past run's exploration genuinely selected a customer this way and the resulting record really saved; the written test copied the identical click-then-press sequence and Enter fired before anything was highlighted, so the field stayed empty, a required-field validation silently blocked the save, and the test hung waiting for a network response that was never going to come. Before writing (or, better, before even relying on) a bare press('Enter') to confirm a selection — in exploration or in the file you write — use wait to confirm an option is actually visible/ready first, and write that same wait into the test file immediately before the press, not just the press by itself.

Proving persistence, not just a clean-looking form: when a feature creates, saves, submits, or otherwise persists something, the test's FINAL assertion must prove the change actually persisted on the server — not just that the form looks fine at that instant. A save/submit click triggers an async request; the moment right after clicking it is still the PRE-save state on screen. If every assertion the test makes would already be true before that request finishes, Playwright can tear the browser context down as soon as the test function returns — which can cut the save request off before it ever completes, so the test passes without the record ever actually being created. Bad: asserting no validation-error text is shown, or that a value you just typed is still visible in the form — both are already true before the save request resolves, proving nothing. Good: assert on something that only becomes true AFTER persistence completes — a generated reference/ID appearing (e.g. matching /ORDER-\d+/ or whatever this app's real pattern is), the URL or breadcrumb changing away from a "new"/"create" state, or an explicit page.waitForResponse(...) matching the real save request you already saw succeed via browser_action's apiCalls during exploration, awaited before any further assertions. If you never actually watched a real save succeed during exploration — checked its apiCalls entry, not just that the DOM looked fine afterward — go verify that live first rather than guessing what the success signal looks like.

Rules:
- Prefer Playwright and role-based selectors (getByRole, getByLabel, getByText).
${
	context.orbitConfig.blind
		? '- There is no source to read in this run — derive every selector from browser_action, verified live, never from a guess at how this kind of element "usually" works.'
		: "- Use read_file to look at the actual markup of a component or route before writing selectors against it — do not guess. Use browser_action when you need to see what's actually rendered, not just what the source suggests."
}
- Before asserting on the URL or page a user is redirected to after an action (a submit, a click), verify the actual destination with browser_action rather than inferring it from a component's name or file location — a component's name is not proof of its route. Guessing this costs a wasted repair attempt when it's wrong; browser_action gets you the real answer up front.
- write_test_file only accepts paths inside the project's configured test directory (${
		context.orbitConfig.testDir
	}). run_test's filePath argument, when scoping a run to one file, is also relative to that same directory (${
		context.orbitConfig.testDir
	}) — not the project root.
- write_test_file's features argument: short, lowercase, dot-separated names (e.g. "checkout", "checkout.payment") — a broad feature and, where it genuinely applies, a specific sub-feature, matching the same convention used in the project index above. List every sub-feature the file covers if it groups more than one. Keep this accurate on every call, including repair retries — it's used for coverage tracking, not just documentation.
- Do not invent project features you have not verified by reading a file.
- Do not attempt to read or use any variables in a .env file.
- If a flow needs something you have no way to obtain yourself (a code sent by email/SMS, a secret only the user has), use request_user_input to ask for it rather than guessing a value or skipping the step silently. The user may decline — if so, stop and report what you couldn't get past.
- Only make request_user_input when you are stuck or cannot proceed without user's input. Do not ask for user input in advance without actually explored the browser and went through the steps
- Do NOT call write_test_file or run_test for any feature where you used request_user_input, whether the user provided the value or declined. There is no safe automated version of this: a persisted test can never obtain a fresh one-time value on a future run, so it would either fail deterministically every time (nothing to fill it with) or — worse — replaying the steps to reach that point again repeats whatever real side effect they have (e.g. clicking "send code" really does send another real email, every single time the test runs, forever). Verify the flow live with browser_action only, then call report_result directly for that feature with file: null, status reflecting what you actually observed, requiresManualInput: true, and manualStepOutcome set to whether the manually-assisted step itself worked. State in the summary that no automated test was written and why.
- Every result you give report_result needs a confidence: 'certain' or 'uncertain'. Mark 'uncertain' when you genuinely cannot tell whether an outcome is actually correct — you already have a way to check this decisively for anything involving browser_action (its apiCalls/consoleErrors fields), so 'uncertain' is specifically for what's left after checking those: a live interaction Playwright may not simulate reliably (drag-and-drop, complex gestures), or behavior with no network/console evidence pointing either way. Do not mark everything 'certain' by default to avoid the extra step — that defeats the entire point of the field.
- If you mark a result 'uncertain', call confirm_outcome for that exact feature BEFORE calling report_result — show the user what you actually did and the real evidence (not your interpretation of it), and use their answer as that feature's actual status. report_result will reject an 'uncertain' result it hasn't already gotten a matching confirm_outcome call for; the feature name you pass to confirm_outcome must exactly match the one you then use in report_result.
- Every result reported as 'failed' or 'gave_up' needs a rootCause: the specific reason it failed, not a restatement of the summary. "Timed out while saving" is not a root cause; "getByRole('combobox').click() was intercepted by its own already-open dropdown" is. If you genuinely don't know why it failed, look again — reread run_test's error/stackTrace, or take a fresh browser_action snapshot — before calling report_result, rather than guessing. report_result rejects a failed/gave_up result with no rootCause. This gets written to project memory for the next run against this project to read, so a vague rootCause is exactly as useless to that future run as none at all.
- Every result also needs explorationResult/explorationReason and backendResult/backendReason — a breakdown of where the pipeline actually stood, since any one of live exploration, the real backend request, and the written Playwright test can be the actual point of failure while the others are fine, and an overall status/rootCause alone doesn't say which. explorationResult is about whether YOU, live with browser_action, actually got the flow to work — not whether the written test passed. backendResult is specifically about the real server response for whatever this feature creates/saves/submits: mark 'confirmed-success' ONLY if you actually checked the real response (browser_action's apiCalls, or an explicit network wait in the test) and it succeeded — never mark it 'confirmed-success' just because the UI looked fine afterward, since the UI can look fine before an async save has even finished. Mark 'unverified' rather than guessing if you never actually checked. Each needs its own one-line reason distinct from summary/rootCause — report_result rejects a result with either reason missing or blank.
- Call report_result exactly once, when you are completely done with every feature, with one result entry per feature. Do not stop without calling it.`;
}

// Blind mode has strictly less information than normal mode when a
// generated Playwright script fails — no read_file/graphify to check *why*
// a script-only signal disagrees with what was actually observed live, just
// an accessibility snapshot. Confirmed against a real run (RicardoLighting,
// "create a quotation"): live exploration completed the flow and the
// backend's own web_save response was checked and confirmed, but the
// scripted replay hung on that same save across four independent runs —
// the script's own limitation, not evidence the feature is broken. This
// only overrides that exact narrow case: real evidence on both other legs
// to lean on instead of the failing script alone. confidence: 'uncertain'
// is deliberately excluded — that path already goes through
// confirm_outcome (a human), and this isn't a second, quieter way around
// that gate. backendResult must be 'confirmed-success' specifically, not
// 'unverified' — same bar the schema already holds self-reports to
// elsewhere (see backendResult's own description: the UI looking fine is
// not enough evidence on its own).
function deriveEffectiveStatus(
	result: FeatureResultInput,
	blind: boolean,
): FeatureResultInput['status'] {
	if (
		blind &&
		result.status === 'failed' &&
		result.confidence === 'certain' &&
		result.explorationResult === 'passed' &&
		result.backendResult === 'confirmed-success'
	) {
		return 'passed';
	}

	return result.status;
}

// The model reports one status per feature, not one for the whole run — the
// overall status is derived rather than declared, so it can't disagree with
// the individual results.
function deriveOverallStatus(
	results: FeatureResult[],
): AgentRunResult['status'] {
	if (results.length === 0) return 'gave_up';
	return results.every(result => result.status === 'passed')
		? 'passed'
		: 'failed';
}

function summarizeFeatureResults(results: FeatureResult[]): string {
	if (results.length === 0) return 'No features were reported';
	const passedCount = results.filter(
		result => result.status === 'passed',
	).length;
	return `${passedCount}/${results.length} feature(s) passed`;
}

export async function runTestingAgent(
	prompt: string,
	context: Omit<
		ToolContext,
		| 'getBrowserWorker'
		| 'hasExploredWithBrowser'
		| 'hasUnconsumedManualInput'
		| 'hasConfirmedOutcome'
		| 'getCurrentExplorationNodeId'
		| 'setCurrentExplorationNodeId'
	>,
	options: RunTestingAgentOptions = {},
): Promise<AgentRunResult> {
	const maxSteps = options.maxSteps ?? 40;
	const client = options.client ?? createOpenAIClient();
	const steps: AgentStep[] = [];

	// Owned by the run, not by any individual tool call — lazily spawned on
	// first use, reused across every feature in this run (paying the launch
	// cost once), respawned if it crashed, and always closed below
	// regardless of how the run ends. A ref-cell object rather than a bare
	// `let`, since a `let` reassigned only inside a nested closure confuses
	// TS's narrowing at the finally block below.
	const browserWorkerRef: {current: BrowserWorkerHandle | null} = {
		current: null,
	};
	const hasUsedBrowserActionRef: {current: boolean} = {current: false};
	const manualInputPendingRef: {current: boolean} = {current: false};
	// Feature names confirm_outcome has resolved for this run — checked by
	// report_result itself (see reportResult.ts) before it'll accept a
	// result marked confidence: 'uncertain'. Exact string match against
	// whatever feature name the model used, which is why confirm_outcome's
	// own description tells it to use the same name it'll pass to
	// report_result.
	const confirmedFeaturesRef: {current: Set<string>} = {current: new Set()};
	// "Where exploration currently is" for the exploration graph — reset to
	// null on every browser_action reset (a fresh context has no page yet),
	// otherwise advanced by browserAction.ts as it builds the graph edge by
	// edge. Session-scoped, not persisted (see explorationGraph.ts).
	const currentExplorationNodeIdRef: {current: string | null} = {
		current: null,
	};
	const toolContext: ToolContext = {
		...context,
		async getBrowserWorker() {
			if (!browserWorkerRef.current || !browserWorkerRef.current.isAlive()) {
				browserWorkerRef.current = spawnBrowserWorker(
					context.projectRoot,
					context.orbitConfig.defaultBrowser,
					context.orbitConfig.baseUrl,
				);
			}

			return browserWorkerRef.current;
		},
		hasExploredWithBrowser: () => hasUsedBrowserActionRef.current,
		hasUnconsumedManualInput: () => manualInputPendingRef.current,
		hasConfirmedOutcome: feature => confirmedFeaturesRef.current.has(feature),
		getCurrentExplorationNodeId: () => currentExplorationNodeIdRef.current,
		setCurrentExplorationNodeId: id => {
			currentExplorationNodeIdRef.current = id;
		},
	};

	// Computed once, not per-turn — scanMode, the graph's presence on disk,
	// and blind mode don't change mid-run. explain_symbol is only ever
	// offered to the model when graphify actually produced a graph for this
	// project; otherwise the tool doesn't exist as far as the model is
	// concerned, rather than existing and failing every call. read_file is
	// removed entirely for a blind project — there is no local source to
	// read, and leaving it available would let the model shortcut past live
	// verification by reading its own previously-generated test specs
	// directly instead of re-confirming a selector via browser_action
	// first, which is exactly the gap the verified-selector discipline
	// elsewhere in this file exists to close.
	//
	// !blind is checked explicitly here too, not left implicit — blind
	// mode's own init always leaves scanMode null and the pre-test scan
	// skips blind projects entirely, but /config's scanMode field has no
	// blind-awareness of its own (it's a plain editable enum), and nothing
	// stops a user from setting it to 'graphify' by hand. That alone can't
	// add explain_symbol (graphifyGraphExists would still be false), but
	// runAskFlow's refreshGraphifyIfEnabled reacts to scanMode alone and
	// would actually run graphify against a blind workspace if it saw
	// 'graphify' there — a graph existing afterward, however that
	// happened, must never be enough on its own to add this tool.
	const hasGraphify =
		!context.orbitConfig.blind &&
		context.orbitConfig.scanMode === 'graphify' &&
		graphifyGraphExists(context.projectRoot);

	const baseToolRegistry = context.orbitConfig.blind
		? toolRegistry.filter(tool => tool.name !== 'read_file')
		: toolRegistry;

	const activeToolRegistry: ToolDefinition[] = hasGraphify
		? [...baseToolRegistry, explainSymbolTool]
		: baseToolRegistry;

	let previousResponseId: string | undefined;
	let nextInput: string | ResponseInputItem[] = prompt;

	try {
		for (let stepCount = 0; stepCount < maxSteps; stepCount++) {
			if (context.signal.aborted) {
				return {
					status: 'aborted',
					summary: 'Aborted by user',
					results: [],
					steps,
				};
			}

			// Re-read fresh every turn, not once before the loop — a tool call
			// earlier in this same run (e.g. write_test_file classifying a
			// shared component while working on a different feature) should be
			// visible to later turns, not just to the next run. This costs
			// nothing extra: the API never carries `instructions` across
			// previous_response_id chaining regardless (each call's
			// instructions fully replaces the last, confirmed via the SDK's
			// own docs), so there was never a reason for this to be a fixed
			// snapshot in the first place.
			const projectMap = readProjectMap(context.projectRoot);
			const memory = readProjectMemory(context.projectRoot);
			const knownClassifications = summarizeKnownClassifications(
				context.projectRoot,
			);
			const testsWrittenThisRun = collectTestsWrittenThisRun(
				steps,
				context.projectRoot,
			);

			const turn: AgentTurnResult = await runAgentTurn<ToolContext>({
				client,
				model: 'gpt-5.2',
				instructions: buildSystemPrompt(
					toolContext,
					projectMap,
					memory,
					knownClassifications,
					testsWrittenThisRun,
					hasGraphify,
					steps,
				),
				input: nextInput,
				previousResponseId,
				toolRegistry: activeToolRegistry,
				context: toolContext,
				signal: context.signal,
				steps,
				onProgress: options.onProgress,
				onUsage(usage) {
					recordUsage(usage.inputTokens, usage.outputTokens);
				},
				onToolDispatched(name) {
					if (name === 'browser_action') {
						hasUsedBrowserActionRef.current = true;
					}
				},
				onToolResult(name, args, result) {
					if (name === 'request_user_input' && result.ok) {
						manualInputPendingRef.current = true;
					} else if (
						name === 'browser_action' &&
						result.ok &&
						(args as {action?: string}).action === 'fill'
					) {
						manualInputPendingRef.current = false;
					} else if (name === 'confirm_outcome' && result.ok) {
						confirmedFeaturesRef.current.add(
							(args as {feature: string}).feature,
						);
					}

					options.onStepResult?.(name, args, result);
				},
			});

			previousResponseId = turn.responseId;

			if (turn.functionCalls.length === 0) {
				return {
					status: 'gave_up',
					summary:
						turn.outputText || 'Agent stopped without reporting a result',
					results: [],
					steps,
				};
			}

			const reportCall = turn.dispatchedCalls.find(
				call => call.name === 'report_result',
			);
			if (reportCall && reportCall.result.ok) {
				const data = reportCall.result.data as ReportResultArgs;
				// playwrightStage is the one stage never trusted to the model's
				// own self-report (unlike explorationResult/backendResult) — it's
				// derived here from run_test's own structured result, the same
				// file-keyed lookup formatAgentRunResult/agentRunResultToJson
				// already use to correlate a feature with its actual test run.
				const runResultsByFile = collectRunResultsByFile(steps);
				const results: FeatureResult[] = data.results.map(result => {
					const run = result.file
						? runResultsByFile.get(result.file)
						: undefined;
					const effectiveStatus = deriveEffectiveStatus(
						result,
						context.orbitConfig.blind,
					);
					return {
						...result,
						status: effectiveStatus,
						modelReportedStatus:
							effectiveStatus === result.status ? undefined : result.status,
						playwrightStage: run
							? run.result.passed
								? 'passed'
								: 'failed'
							: 'not-run',
					};
				});

				return {
					status: deriveOverallStatus(results),
					summary: summarizeFeatureResults(results),
					results,
					steps,
				};
			}

			nextInput = turn.outputItems;
		}

		return {
			status: 'gave_up',
			summary: `Stopped after ${maxSteps} steps without a final result`,
			results: [],
			steps,
		};
	} finally {
		browserWorkerRef.current?.close();
	}
}

const STATUS_LABEL: Record<AgentRunResult['status'], string> = {
	passed: 'Test passed',
	failed: 'Test failed',
	gave_up: 'Gave up',
	aborted: 'Aborted',
};

const TEST_STATUS_ICON: Record<TestStatus, string> = {
	passed: '✓',
	failed: '✘',
	timedOut: '✘',
	skipped: '○',
	other: '?',
};

// Playwright-style: one line per test, not just an aggregate count or a
// failures-only list — this is what run_test's full per-test data (not
// just failures) was extended to support.
function formatTestList(
	tests: TestOutcome[],
	failures: TestFailureDetail[],
): string {
	const errorByTitle = new Map(
		failures.map(failure => [failure.testTitle, failure.errorMessage]),
	);

	return tests
		.map(test => {
			const line = `    ${TEST_STATUS_ICON[test.status]} ${test.title} (${
				test.durationMs
			}ms)`;
			const errorMessage = errorByTitle.get(test.title);
			return errorMessage ? `${line}\n        ${errorMessage}` : line;
		})
		.join('\n');
}

const FEATURE_STATUS_ICON: Record<FeatureResult['status'], string> = {
	passed: '✓',
	failed: '✗',
	gave_up: '?',
};

const EXPLORATION_ICON: Record<FeatureResult['explorationResult'], string> = {
	passed: '✓',
	failed: '✗',
	'not-attempted': '?',
};

const BACKEND_ICON: Record<FeatureResult['backendResult'], string> = {
	'confirmed-success': '✓',
	'confirmed-failure': '✗',
	unverified: '?',
};

const PLAYWRIGHT_STAGE_ICON: Record<FeatureResult['playwrightStage'], string> =
	{
		passed: '✓',
		failed: '✗',
		'not-run': '?',
	};

// Keyed by file rather than kept as a single "last result" — repeated
// run_test calls scoped to the SAME file (repair iterations) correctly
// overwrite each other here, but calls for DIFFERENT files each keep their
// own latest result instead of the later one silently erasing the earlier
// one's pass/fail data.
function collectRunResultsByFile(
	steps: AgentStep[],
): Map<string, {result: RunTestResult; attempts: number}> {
	const byFile = new Map<string, {result: RunTestResult; attempts: number}>();

	for (let i = 0; i < steps.length; i++) {
		const call = steps[i];
		if (call?.type !== 'tool_call' || call.name !== 'run_test') continue;

		const resultStep = steps[i + 1];
		if (resultStep?.type !== 'tool_result' || !resultStep.result.ok) continue;

		const args = call.args as {filePath?: string | null};
		if (!args.filePath) continue; // Whole-suite run — not attributable to one feature

		const existing = byFile.get(args.filePath);
		byFile.set(args.filePath, {
			result: resultStep.result.data as RunTestResult,
			attempts: (existing?.attempts ?? 0) + 1,
		});
	}

	return byFile;
}

export function formatAgentRunResult(result: AgentRunResult): string {
	if (result.results.length === 0) {
		return `${STATUS_LABEL[result.status]}: ${result.summary}`;
	}

	const runResultsByFile = collectRunResultsByFile(result.steps);

	const featureBlocks = result.results.map(feature => {
		const run = feature.file ? runResultsByFile.get(feature.file) : undefined;
		const testsText = run
			? `${run.result.passedCount}/${run.result.totalTests} passed (${run.result.durationMs}ms)`
			: feature.file
			? 'not run'
			: 'verified live, no automated test';
		const attemptsText =
			run && run.attempts > 1 ? `, ${run.attempts} attempts` : '';

		const testListText =
			run && run.result.tests.length > 0
				? '\n' + formatTestList(run.result.tests, run.result.failures)
				: '';

		const manualTag = feature.requiresManualInput
			? ` [manual step ${
					feature.manualStepOutcome ?? 'unknown'
			  } — not unattended-repeatable]`
			: '';

		const stageLines = `    Browser exploration:  ${
			EXPLORATION_ICON[feature.explorationResult]
		} ${feature.explorationResult} — ${feature.explorationReason}
    Backend (API):         ${BACKEND_ICON[feature.backendResult]} ${
			feature.backendResult
		} — ${feature.backendReason}
    Playwright test:       ${PLAYWRIGHT_STAGE_ICON[feature.playwrightStage]} ${
			feature.playwrightStage
		}`;

		return `${FEATURE_STATUS_ICON[feature.status]} ${feature.feature} (${
			feature.file ?? 'no test file'
		})${manualTag} — ${testsText}${attemptsText}
${stageLines}
    ${feature.summary}${testListText}`;
	});

	return `${STATUS_LABEL[result.status]}: ${result.summary}

${featureBlocks.join('\n\n')}`;
}

export type AgentRunResultJson = {
	status: AgentRunResult['status'];
	summary: string;
	features: Array<{
		feature: string;
		file: string | null;
		status: FeatureResult['status'];
		summary: string;
		rootCause: string | null;
		explorationResult: FeatureResult['explorationResult'];
		explorationReason: string;
		backendResult: FeatureResult['backendResult'];
		backendReason: string;
		playwrightStage: FeatureResult['playwrightStage'];
		requiresManualInput: boolean;
		manualStepOutcome: 'succeeded' | 'failed' | null;
		// Null when the feature has no correlated run_test call at all — a
		// manual-input feature with no test file, or a whole-suite run_test
		// call that collectRunResultsByFile can't attribute to one feature.
		tests: {
			totalTests: number;
			passedCount: number;
			failedCount: number;
			durationMs: number;
			attempts: number;
			tests: TestOutcome[];
			failures: TestFailureDetail[];
		} | null;
	}>;
};

// The machine-readable counterpart to formatAgentRunResult — same
// feature/test-result correlation via collectRunResultsByFile, just shaped
// for a CI system to parse (--ci --json) instead of a human to read.
export function agentRunResultToJson(
	result: AgentRunResult,
): AgentRunResultJson {
	const runResultsByFile = collectRunResultsByFile(result.steps);

	return {
		status: result.status,
		summary: result.summary,
		features: result.results.map(feature => {
			const run = feature.file ? runResultsByFile.get(feature.file) : undefined;

			return {
				feature: feature.feature,
				file: feature.file,
				status: feature.status,
				summary: feature.summary,
				rootCause: feature.rootCause,
				explorationResult: feature.explorationResult,
				explorationReason: feature.explorationReason,
				backendResult: feature.backendResult,
				backendReason: feature.backendReason,
				playwrightStage: feature.playwrightStage,
				requiresManualInput: feature.requiresManualInput,
				manualStepOutcome: feature.manualStepOutcome,
				tests: run
					? {
							totalTests: run.result.totalTests,
							passedCount: run.result.passedCount,
							failedCount: run.result.failedCount,
							durationMs: run.result.durationMs,
							attempts: run.attempts,
							tests: run.result.tests,
							failures: run.result.failures,
					  }
					: null,
			};
		}),
	};
}
