import process from 'node:process';
import {detectProjectRoot} from './projects/search.js';
import {readOrbitConfig} from './init/config.js';
import {isReachable} from './projects/reachability.js';
import {
	scanProjectWithModeSelection,
	graphifyOutcomeMessage,
} from './projects/scanOrchestration.js';
import {writeProjectMap} from './projects/scan.js';
import {
	runTestingAgent,
	formatAgentRunResult,
	describeAgentActivity,
} from './ai/agent.js';
import {writeAgentSession, writeManualInputTestRecords} from './ai/session.js';
import {describeOrbitError} from './commands/error.js';
import {cleanupTrackedProcesses} from './projects/processTracking.js';

// Injectable so runCi's branching logic (the pre-flight checks below) can be
// unit-tested against fake deps — real project/network/OpenAI calls, not
// mocks of them — the same pattern ScanOrchestrationDeps already uses.
// Defaults are the real modules; only overridden in tests.
export type CiDeps = {
	detectProjectRoot: typeof detectProjectRoot;
	readOrbitConfig: typeof readOrbitConfig;
	isReachable: typeof isReachable;
	scanProjectWithModeSelection: typeof scanProjectWithModeSelection;
	writeProjectMap: typeof writeProjectMap;
	runTestingAgent: typeof runTestingAgent;
	writeAgentSession: typeof writeAgentSession;
	writeManualInputTestRecords: typeof writeManualInputTestRecords;
	log: (message: string) => void;
	logError: (message: string) => void;
	// Only reached by the second-signal force-exit escalation below — kept
	// injectable rather than calling process.exit directly (both to satisfy
	// unicorn/no-process-exit, which reserves that call for the actual CLI
	// entry point, and so a test can exercise the escalation path without
	// really killing the test process).
	exit: (code: number) => never;
};

const defaultDeps: CiDeps = {
	detectProjectRoot,
	readOrbitConfig,
	isReachable,
	scanProjectWithModeSelection,
	writeProjectMap,
	runTestingAgent,
	writeAgentSession,
	writeManualInputTestRecords,
	log(message) {
		console.log(message);
	},
	logError(message) {
		console.error(message);
	},
	exit(code) {
		process.exit(code);
	},
};

// Exit codes: 0 = ran, every feature passed. 1 = ran to completion, at
// least one feature failed/gave up (a real result). 2 = never produced a
// real result (bad project, wrong approval mode, unreachable, unexpected
// exception, or the run was cancelled via SIGINT/SIGTERM before finishing).
const EXIT_PASSED = 0;
const EXIT_FEATURE_FAILED = 1;
const EXIT_COULD_NOT_RUN = 2;

// SIGINT/SIGTERM get one graceful chance to unwind: abort the run's
// AbortController so an in-flight OpenAI call is cancelled (the SDK call
// already receives this signal) and runTestingAgent's own `finally` block
// gets to close the browser worker — rather than the process just vanishing
// mid-flight (the previous behavior: a blunt top-level handler that called
// process.exit(0) immediately) and leaving that child process orphaned.
// This can't do anything about an in-flight tool call that doesn't itself
// watch the signal (e.g. mid browser_action) — that step still has to
// finish on its own before the loop's next per-iteration abort check is
// reached — so a second signal escalates to an immediate forced exit,
// matching the interactive CLI's existing behavior for the case where
// graceful cleanup isn't resolving.
function installCiSignalHandling(
	controller: AbortController,
	deps: CiDeps,
): () => void {
	let signalCount = 0;

	function onSignal(signal: NodeJS.Signals): void {
		signalCount += 1;

		if (signalCount === 1) {
			deps.logError(
				`\nReceived ${signal} — stopping after the current step finishes. Press Ctrl-C again to force quit.`,
			);
			controller.abort();
			return;
		}

		deps.logError(`\nReceived ${signal} again — forcing exit.`);
		cleanupTrackedProcesses();
		deps.exit(EXIT_COULD_NOT_RUN);
	}

	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	return () => {
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
	};
}

// CI-generated tests land inside .orbit/, not the project's configured
// (interactive) testDir — keeps a headless pipeline run from mixing its
// output in with tests a human wrote/reviewed interactively, and keeps them
// out of the source tree the regex/graphify scan walks (.orbit is already
// in its ignore list) since they're regenerated fresh on every CI run
// rather than being something to review as source. Only overridden for the
// runTestingAgent call below; everything else (the pre-test scan,
// manualTestDir) still uses the project's real config as-is.
const CI_TEST_DIR = '.orbit/orbit-ci';

// The headless counterpart to /test — same runTestingAgent call, same
// session/manual-input file writes, but with every interactive prompt
// (requestApproval, requestInput, requestOutcomeConfirmation,
// requestScanMode) replaced by a fixed, non-interactive answer instead of
// waiting on a human. See the plan this was built from for why each of
// these specific defaults was chosen over the alternatives.
export async function runCi(
	prompt: string,
	overrides: Partial<CiDeps> = {},
): Promise<number> {
	const deps: CiDeps = {...defaultDeps, ...overrides};
	const controller = new AbortController();
	const uninstallSignalHandling = installCiSignalHandling(controller, deps);

	try {
		return await runCiBody(prompt, deps, controller);
	} finally {
		uninstallSignalHandling();
	}
}

async function runCiBody(
	prompt: string,
	deps: CiDeps,
	controller: AbortController,
): Promise<number> {
	const detected = deps.detectProjectRoot();
	if (!detected.isProject || !detected.root) {
		deps.logError(describeOrbitError({kind: 'no-project-selected'}));
		return EXIT_COULD_NOT_RUN;
	}

	const projectRoot = detected.root;

	if (!detected.hasOrbitFolder) {
		deps.logError(
			`${describeOrbitError({
				kind: 'project-not-initialized',
			})} CI mode does not auto-init — run /init interactively first.`,
		);
		return EXIT_COULD_NOT_RUN;
	}

	const orbitConfig = deps.readOrbitConfig(projectRoot);
	if (!orbitConfig) {
		deps.logError(
			`${describeOrbitError({
				kind: 'project-not-initialized',
			})} .orbit/config.json exists but couldn't be read.`,
		);
		return EXIT_COULD_NOT_RUN;
	}

	if (
		orbitConfig.approvalMode !== 'always' ||
		orbitConfig.writeMode !== 'always'
	) {
		const wrongFields = [
			orbitConfig.approvalMode !== 'always' && 'approvalMode',
			orbitConfig.writeMode !== 'always' && 'writeMode',
		].filter(Boolean);
		deps.logError(
			`CI mode requires approvalMode and writeMode to both be "always" — currently ${wrongFields.join(
				' and ',
			)} still "ask". There's no human to answer an approval prompt in CI. Run /config interactively to change ${
				wrongFields.length > 1 ? 'them' : 'it'
			} first.`,
		);
		return EXIT_COULD_NOT_RUN;
	}

	if (!(await deps.isReachable(orbitConfig.baseUrl))) {
		deps.logError(
			`${orbitConfig.baseUrl} is not reachable. CI mode does not attempt to auto-start the dev environment (unlike /test interactively) — bring it up in an earlier pipeline step first.`,
		);
		return EXIT_COULD_NOT_RUN;
	}

	try {
		const {projectMap, graphifyOutcome} =
			await deps.scanProjectWithModeSelection(projectRoot, {
				requestApproval: async () => true,
				requestScanMode: async () => 'regex',
				// Safe no-op today: neither the 'regex' branch nor the
				// already-'graphify' branch of resolveScanModeChoice posts
				// any message on this path — only the install-prompt flow
				// does, which CI's requestScanMode (always 'regex') never
				// reaches. If scanOrchestration.ts changes to post on
				// those paths too, this would silently drop them.
				setMessages() {},
			});
		deps.writeProjectMap(projectRoot, projectMap);

		const graphifyMessage = graphifyOutcomeMessage(graphifyOutcome);
		if (graphifyMessage) {
			deps.log(graphifyMessage.content);
		}
	} catch (error) {
		// Non-fatal — matches /test's own pre-test rescan handling: log a
		// warning and proceed with whatever project map already exists.
		deps.logError(
			`Pre-test project scan failed, proceeding with the existing project index: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}

	const ciOrbitConfig = {...orbitConfig, testDir: CI_TEST_DIR};

	let result;
	try {
		result = await deps.runTestingAgent(
			prompt,
			{
				projectRoot,
				orbitConfig: ciOrbitConfig,
				signal: controller.signal,
				requestApproval: async () => true,
				requestInput: async () => null,
				async requestOutcomeConfirmation(feature, whatWasDone, output) {
					deps.log(
						`"${feature}" was marked uncertain but there's no human to confirm it in CI mode — auto-resolving as failure.\nWhat it did: ${whatWasDone}\nWhat happened: ${output}`,
					);
					return 'failure';
				},
			},
			{
				onProgress(event) {
					deps.log(describeAgentActivity(event));
				},
			},
		);
	} catch (error) {
		deps.logError(
			`Test agent run failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return EXIT_COULD_NOT_RUN;
	}

	deps.writeAgentSession(projectRoot, prompt, result);
	deps.writeManualInputTestRecords(projectRoot, orbitConfig, result.results);

	deps.log(formatAgentRunResult(result));

	// A cancelled run (SIGINT/SIGTERM during runTestingAgent) reports its own
	// status as 'aborted' rather than throwing — it's neither a pass nor a
	// real pass/fail verdict on the feature, so it gets the same exit code as
	// "never produced a real result" rather than being counted as a failure.
	if (result.status === 'aborted') {
		return EXIT_COULD_NOT_RUN;
	}

	return result.status === 'passed' ? EXIT_PASSED : EXIT_FEATURE_FAILED;
}
