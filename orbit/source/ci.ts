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
};

// Exit codes: 0 = ran, every feature passed. 1 = ran, at least one feature
// failed/gave up (a real result). 2 = never got to run at all (bad
// project, wrong approval mode, unreachable, unexpected exception).
const EXIT_PASSED = 0;
const EXIT_FEATURE_FAILED = 1;
const EXIT_COULD_NOT_RUN = 2;

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

	const controller = new AbortController();
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

	return result.status === 'passed' ? EXIT_PASSED : EXIT_FEATURE_FAILED;
}
