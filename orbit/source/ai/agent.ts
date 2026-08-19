import fs from 'node:fs';
import path from 'node:path';
import type {ResponseInputItem} from 'openai/resources/responses/responses';
import {graphifyGraphExists} from '../projects/graphifyGraph.js';
import {readProjectMap, type ProjectMap} from '../projects/scan.js';
import {readProjectMemory, type ProjectMemory} from '../init/memory.js';
import {readFeatureClassifications} from '../projects/featureClassification.js';
import {checksumFromContent} from '../projects/checksum.js';
import {createOpenAIClient, type ResponsesClient} from './client.js';
import {
	toolRegistry,
	explainSymbolTool,
	type ToolContext,
	type ToolDefinition,
} from './tools/index.js';
import {spawnBrowserWorker, type BrowserWorkerHandle} from './browserWorker.js';
import {
	runAgentTurn,
	type AgentStep,
	type AgentProgressEvent,
	type AgentTurnResult,
} from './agentLoop.js';
import type {ReportResultArgs, FeatureResult} from './tools/reportResult.js';
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

export type RunTestingAgentOptions = {
	maxSteps?: number;
	client?: ResponsesClient;
	onProgress?: (event: AgentProgressEvent) => void;
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

// Reuses whatever /scan already computed instead of leaving the model to
// guess file paths blind — read_file still exists for the actual deep dive
// once it knows which file is relevant. extraTestFiles covers the one gap
// the last /scan can't: test files this run has itself written since that
// scan ran, which won't be in projectMap yet.
function summarizeProjectMap(
	projectMap: ProjectMap | null,
	extraTestFiles: string[],
): string {
	if (!projectMap) {
		return 'No project index available yet (run /scan first for a list of known routes and components) — you will need to find files by informed guesswork.';
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
	environment?:boolean;
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
			`## Testing decisions and conventions\n${memory.decisions ? memory.decisions : "No content yet"}`,
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
): string {
	return `You are Orbit, an AI QA agent for E2E testing.

Your job: given a description of one or more features to test, write a Playwright test for each feature using the write_test_file tool, then run it using the run_test tool.

If the prompt describes multiple distinct features, group the features according to the cateogories as there maybe sub-features within a single feature. Group those sub-feature in a single test file — do not combine multiple features into a single file. This keeps a repair cheap (you only need to resend the one file you're fixing, not every feature's test code) and keeps a failure in one feature from blocking the others. Use run_test's filePath argument to run and repair one feature's file independently of the others.

${summarizeProjectMap(projectMap, testsWrittenThisRun)}

Files already confirmed by feature (from past runs — read the file directly if what you need is listed here, instead of exploring blind):
${knownClassifications}

Use the project index above to find the right file to read before writing selectors — prefer it over guessing paths. If a feature you're asked to test isn't listed anywhere, use read_file to explore starting from a route or component that seems related.
${
	hasExplainSymbol
		? "\nA code knowledge graph is available for this project (explain_symbol). When you start a NEW feature, before any read_file calls, call explain_symbol on the most relevant entry point — the route or component the project index above points to — to see what it's connected to (other components, API handlers, shared utilities). Use that map to decide what actually needs reading, rather than opening the first plausible file and expanding your understanding one read_file call at a time. Keep doing this as you go, too: call explain_symbol on any further route, component, or function BEFORE your first read_file call on it, every time — this is your default first move for anything you haven't already explored this run, not something to reach for only once you notice you need it. It's far cheaper than opening a file and often tells you everything you need (what it imports, what calls it, where it lives) without a read at all. Only fall back to read_file once you actually need to see the real code — exact markup, prop names, JSX structure, selectors — not just its relationships to the rest of the codebase.\n"
		: ''
}
Project memory (read this before writing anything — avoid repeating documented failure patterns and follow documented conventions):

${summarizeMemory(memory)}

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

Rules:
- Prefer Playwright and role-based selectors (getByRole, getByLabel, getByText).
- Use read_file to look at the actual markup of a component or route before writing selectors against it — do not guess. Use browser_action when you need to see what's actually rendered, not just what the source suggests.
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
- Call report_result exactly once, when you are completely done with every feature, with one result entry per feature. Do not stop without calling it.`;
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
	};

	// Computed once, not per-turn — scanMode and the graph's presence on
	// disk don't change mid-run. explain_symbol is only ever offered to the
	// model when graphify actually produced a graph for this project;
	// otherwise the tool doesn't exist as far as the model is concerned,
	// rather than existing and failing every call.
	const activeToolRegistry: ToolDefinition[] =
		context.orbitConfig.scanMode === 'graphify' &&
		graphifyGraphExists(context.projectRoot)
			? [...toolRegistry, explainSymbolTool]
			: toolRegistry;

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
					activeToolRegistry !== toolRegistry,
				),
				input: nextInput,
				previousResponseId,
				toolRegistry: activeToolRegistry,
				context: toolContext,
				signal: context.signal,
				steps,
				onProgress: options.onProgress,
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
				return {
					status: deriveOverallStatus(data.results),
					summary: summarizeFeatureResults(data.results),
					results: data.results,
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

		return `${FEATURE_STATUS_ICON[feature.status]} ${feature.feature} (${
			feature.file ?? 'no test file'
		})${manualTag} — ${testsText}${attemptsText}
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
