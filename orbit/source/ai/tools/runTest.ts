import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {resolveConfiguredDir} from '../../init/config.js';
import {getOrbitDir} from '../../init/orbitDir.js';
import {readFeatureClassifications} from '../../projects/featureClassification.js';
import {getAuthSetupPath, getStorageStatePath} from './writeAuthSetup.js';
import type {ToolDefinition} from './types.js';

export type TestFailureDetail = {
	testTitle: string;
	errorMessage: string;
	stackTrace: string;
	screenshotPath?: string;
	tracePath?: string;
	videoPath?: string;
	// Playwright's own error-context.md attachment (lib/errorContext.js) —
	// specifically the accessibility-tree snapshot of the page at the
	// exact moment of failure, the one part of that file that's genuinely
	// new information for the model. errorMessage above already covers
	// what Playwright's "Error details" section says, and the model
	// already knows its own test source — the page snapshot is the only
	// piece it has no other way to see, and it's exactly what a human
	// would open the file to check first.
	pageSnapshotAtFailure?: string;
};

export type TestStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'other';

export type TestOutcome = {
	title: string;
	status: TestStatus;
	durationMs: number;
};

export type RunTestResult = {
	passed: boolean;
	totalTests: number;
	passedCount: number;
	failedCount: number;
	tests: TestOutcome[];
	failures: TestFailureDetail[];
	durationMs: number;
	reportPath: string;
};

export function findPlaywrightBinary(projectRoot: string): string | null {
	const binName =
		process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
	const binPath = path.join(projectRoot, 'node_modules', '.bin', binName);
	return fs.existsSync(binPath) ? binPath : null;
}

// Generated fresh before every run rather than scaffolded once at /init —
// always reflects the current orbit config, and avoids ever needing to
// read or patch the user's own playwright.config.*. Absolute paths only,
// so there's no relative-path resolution ambiguity to get wrong. .mjs
// forces ESM regardless of the user's package.json "type" field.
function buildOrbitPlaywrightConfigSource(
	testDirAbsolute: string,
	baseUrl: string,
	outputDirAbsolute: string,
	// Set only when this run should start pre-authenticated — omitted
	// entirely (not just left undefined in `use`) for the auth-setup run
	// itself (which needs a genuinely fresh, logged-out context to log in
	// from) and for any run where storageState doesn't apply, rather than
	// pointing at a file that doesn't exist yet or shouldn't be used. See
	// run_test's own decision of when to pass this.
	storageStatePath: string | null,
	// Playwright's own default testMatch only matches *.spec.ts/*.test.ts —
	// auth.setup.ts doesn't fit that pattern and is silently excluded even
	// when passed as an explicit CLI argument, confirmed directly (a real
	// run against it reported "No tests found" despite the file existing
	// and being named on the command line). Only the auth-setup run itself
	// needs this override; the real test run keeps Playwright's own default.
	testMatch: string | null = null,
): string {
	return `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: ${JSON.stringify(testDirAbsolute)},
  outputDir: ${JSON.stringify(outputDirAbsolute)},${
			testMatch ? `\n  testMatch: ${testMatch},` : ''
		}
  // Playwright's own default (30s) is sized for a typical unit-style test
  // against a mocked/local backend. Orbit tests a real, running app end to
  // end — login, navigation, and every search/select round-trip all hit a
  // real backend — so a multi-step flow can legitimately need more wall
  // clock than that even when every step succeeds. Confirmed against a
  // real failure: a well-formed generated test hit exactly this 30s
  // ceiling while still correctly waiting on a save response that simply
  // hadn't arrived yet, not because anything was actually broken.
  timeout: 60_000,${
			storageStatePath
				? `
  // Every worker that loads the same storageState file replays the exact
  // same session cookie — meaning they all share ONE authenticated session
  // on the real backend, not just the same client-side browser state. An
  // app that keeps any server-side "current" state tied to that session
  // (e.g. Odoo's own last-visited menu, restored on the next page load) can
  // then race across workers: one worker's navigation can silently change
  // what another worker's next page load lands on. Confirmed directly: a
  // written test that navigated to the root URL then clicked an
  // app-switcher tile timed out running in parallel with two sibling
  // tests sharing the same storageState, then passed cleanly, unchanged,
  // run alone — a real cross-worker race, not a flaky selector. Running
  // serially whenever a shared session is in play trades some wall-clock
  // time for actually deterministic results.
  workers: 1,`
				: ''
		}
  use: {
    baseURL: ${JSON.stringify(baseUrl)},
    // Pinned explicitly to match browserWorker.ts's exploration context —
    // Playwright's "system default locale" fallback resolves differently
    // between headed (exploration) and headless (this run) Chromium on the
    // same machine, confirmed directly against a real app whose login page
    // rendered in two different languages purely because of that gap, not
    // any real session/app variance. Selectors verified live must be
    // verifying the same language's page a real run will actually see.
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',${
			storageStatePath
				? `\n    storageState: ${JSON.stringify(storageStatePath)},`
				: ''
		}
  },
});
`;
}

// requiresFreshSession is stored keyed by path relative to projectRoot (see
// writeTestFile.ts's own recordClassification call) — filePath here is
// relative to testDir, so this re-derives the same key rather than assuming
// they match.
function fileRequiresFreshSession(
	projectRoot: string,
	testDirAbsolute: string,
	filePath: string,
): boolean {
	const relativeToProjectRoot = path.relative(
		projectRoot,
		path.resolve(testDirAbsolute, filePath),
	);
	const entry =
		readFeatureClassifications(projectRoot).entries[relativeToProjectRoot];
	return entry?.requiresFreshSession ?? false;
}

// Whether ANY known test needs a genuinely fresh session — used only for a
// whole-suite run (filePath: null), where a single shared config can't give
// different tests different storageState the way a scoped single-file run
// can. Erring toward "skip storageState for the whole run" rather than
// silently force-authenticating a login test is the safe direction: a test
// that didn't need storageState just does its own login again, same as
// before this existed; a login test force-started pre-authenticated would
// never actually exercise what it's testing.
function anyKnownFileRequiresFreshSession(projectRoot: string): boolean {
	const entries = Object.values(
		readFeatureClassifications(projectRoot).entries,
	);
	return entries.some(entry => entry.requiresFreshSession);
}

// Runs the shared auth.setup.ts (if one has been written) and produces
// storage-state.json for the real run to point at. Returns null (not an
// error) when there's simply no auth setup yet — the very first test in a
// project, before write_auth_setup has ever been called, has nothing to run
// this against, and that's expected, not a failure. Returns an actual error
// only when auth.setup.ts EXISTS but fails to run, since proceeding to the
// real test with a missing/stale storageState at that point would produce a
// confusing downstream failure instead of the real, attributable one.
async function runAuthSetupIfNeeded(
	binPath: string,
	projectRoot: string,
	baseUrl: string,
	indexDir: string,
	signal: AbortSignal,
): Promise<{ok: true; storageStatePath: string | null} | {ok: false; error: string}> {
	const authSetupPath = getAuthSetupPath(projectRoot);
	if (!fs.existsSync(authSetupPath)) {
		return {ok: true, storageStatePath: null};
	}

	const runId = `auth-setup-${Date.now()}`;
	const outputDirAbsolute = path.join(orbitTracesDir(projectRoot), runId);
	fs.mkdirSync(outputDirAbsolute, {recursive: true});

	const configPath = path.join(indexDir, 'auth-setup.playwright.config.mjs');
	fs.writeFileSync(
		configPath,
		// No storageState on this run itself — it needs a genuinely fresh,
		// logged-out context to log in from, same reasoning a
		// requiresFreshSession test does.
		buildOrbitPlaywrightConfigSource(
			indexDir,
			baseUrl,
			outputDirAbsolute,
			null,
			'/.*\\.setup\\.ts$/',
		),
		'utf8',
	);

	const storageStatePath = getStorageStatePath(projectRoot);
	const reportPath = path.join(outputDirAbsolute, 'report.json');

	try {
		await runPlaywrightProcess(
			binPath,
			['test', '--config', configPath, '--reporter=json', authSetupPath],
			projectRoot,
			{
				...process.env,
				PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
				ORBIT_STORAGE_STATE_PATH: storageStatePath,
			},
			signal,
		);
	} catch (error) {
		return {
			ok: false,
			error: `Auth setup failed to run: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	if (!fs.existsSync(reportPath)) {
		return {
			ok: false,
			error: 'Auth setup did not produce a JSON report — it may have failed to start.',
		};
	}

	const result = parsePlaywrightJsonReport(
		fs.readFileSync(reportPath, 'utf8'),
		reportPath,
	);
	if (!result.passed) {
		const failure = result.failures[0];
		return {
			ok: false,
			error: `Auth setup failed: ${
				failure?.errorMessage ?? 'unknown error'
			} — fix it with write_auth_setup before running other tests, since they depend on the session it produces.`,
		};
	}

	if (!fs.existsSync(storageStatePath)) {
		return {
			ok: false,
			error:
				'Auth setup passed but never wrote storage-state.json — its content must call page.context().storageState({ path: process.env.ORBIT_STORAGE_STATE_PATH }) as its final action.',
		};
	}

	return {ok: true, storageStatePath};
}

function orbitTracesDir(projectRoot: string): string {
	return path.join(getOrbitDir(projectRoot), 'traces');
}

async function runPlaywrightProcess(
	binPath: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(binPath, args, {cwd, env, signal});
		child.on('error', reject);
		child.on('close', () => {
			resolve();
		});
	});
}

type JsonReportAttachment = {name?: string; path?: string};
type JsonReportError = {message?: string; stack?: string};
type JsonReportTestResult = {
	status?: string;
	duration?: number;
	error?: JsonReportError;
	errors?: JsonReportError[];
	attachments?: JsonReportAttachment[];
};
type JsonReportTest = {results?: JsonReportTestResult[]};
type JsonReportSpec = {title?: string; ok?: boolean; tests?: JsonReportTest[]};
type JsonReportSuite = {specs?: JsonReportSpec[]; suites?: JsonReportSuite[]};
type JsonReport = {
	suites?: JsonReportSuite[];
	stats?: {
		duration?: number;
		expected?: number;
		unexpected?: number;
		skipped?: number;
		flaky?: number;
	};
};

function normalizeStatus(status: string | undefined): TestStatus {
	switch (status) {
		case 'passed':
		case 'failed':
		case 'timedOut':
		case 'skipped': {
			return status;
		}

		default: {
			return 'other';
		}
	}
}

// Every test, not just the failing ones — collectFailures below only ever
// walked specs that failed, so a passing run had no per-test record at
// all, just an aggregate count. This is what makes the Playwright-style
// list (✓/✘ per test) possible.
function collectAllTests(
	suites: JsonReportSuite[],
	tests: TestOutcome[],
): void {
	for (const suite of suites) {
		for (const spec of suite.specs ?? []) {
			for (const test of spec.tests ?? []) {
				const results = test.results ?? [];
				const lastResult = results[results.length - 1];

				tests.push({
					title: spec.title ?? 'Untitled test',
					status: normalizeStatus(lastResult?.status),
					durationMs: lastResult?.duration ?? 0,
				});
			}
		}

		if (suite.suites?.length) {
			collectAllTests(suite.suites, tests);
		}
	}
}

// Generous on purpose, and higher than it looks like it should need to be:
// measured against a real failure against a complex enterprise app (Odoo),
// the section this pulls from ran 15.6k chars, with the actually-useful
// evidence (the specific empty/mismatched element) sitting past the 8k
// mark, not near the front. This only ever fires on a test FAILURE, not on
// every call the way per-action capture elsewhere in this codebase does —
// getting the diagnosis right is worth more context here than the routine
// caps (2-4k chars) used for things that fire constantly.
const MAX_PAGE_SNAPSHOT_CHARS = 20_000;

// error-context.md's own fixed section order (Instructions, Test info,
// Error details, Page snapshot, Test source) — Instructions is Playwright's
// own prompt for whatever AI reads the file directly, redundant with this
// agent's own system prompt; Test info/Error details duplicate fields
// already on TestFailureDetail; Test source is the model's own code, which
// it already has. Only the snapshot itself is pulled out.
function extractPageSnapshotSection(
	errorContextMarkdown: string,
): string | undefined {
	const sectionStart = errorContextMarkdown.indexOf('# Page snapshot');
	if (sectionStart === -1) return undefined;

	const nextSectionStart = errorContextMarkdown.indexOf(
		'\n# ',
		sectionStart + 1,
	);
	const section = (
		nextSectionStart === -1
			? errorContextMarkdown.slice(sectionStart)
			: errorContextMarkdown.slice(sectionStart, nextSectionStart)
	).trim();

	return section.length > MAX_PAGE_SNAPSHOT_CHARS
		? section.slice(0, MAX_PAGE_SNAPSHOT_CHARS) + '\n... [truncated]'
		: section;
}

function readPageSnapshotAtFailure(
	errorContextPath: string | undefined,
): string | undefined {
	if (!errorContextPath) return undefined;

	try {
		return extractPageSnapshotSection(
			fs.readFileSync(errorContextPath, 'utf8'),
		);
	} catch {
		// Best-effort — a missing/unreadable file just means this failure
		// reports without it, same as any attachment that never got
		// written (e.g. a crash before Playwright could capture one).
		return undefined;
	}
}

function collectFailures(
	suites: JsonReportSuite[],
	failures: TestFailureDetail[],
): void {
	for (const suite of suites) {
		for (const spec of suite.specs ?? []) {
			if (spec.ok) continue;

			for (const test of spec.tests ?? []) {
				const results = test.results ?? [];
				const lastResult = results[results.length - 1];
				if (!lastResult || lastResult.status === 'passed') continue;

				const errorEntry = lastResult.errors?.[0] ?? lastResult.error;
				const attachments = lastResult.attachments ?? [];
				const errorContextPath = attachments.find(
					a => a.name === 'error-context',
				)?.path;

				failures.push({
					testTitle: spec.title ?? 'Untitled test',
					errorMessage: errorEntry?.message ?? 'Unknown error',
					stackTrace: errorEntry?.stack ?? '',
					screenshotPath: attachments.find(a => a.name === 'screenshot')?.path,
					tracePath: attachments.find(a => a.name === 'trace')?.path,
					videoPath: attachments.find(a => a.name === 'video')?.path,
					pageSnapshotAtFailure: readPageSnapshotAtFailure(errorContextPath),
				});
			}
		}

		if (suite.suites?.length) {
			collectFailures(suite.suites, failures);
		}
	}
}

export function parsePlaywrightJsonReport(
	raw: string,
	reportPath: string,
): RunTestResult {
	const report = JSON.parse(raw) as JsonReport;
	const stats = report.stats ?? {};

	const passedCount = stats.expected ?? 0;
	const failedCount = stats.unexpected ?? 0;
	const totalTests =
		passedCount + failedCount + (stats.skipped ?? 0) + (stats.flaky ?? 0);

	const tests: TestOutcome[] = [];
	collectAllTests(report.suites ?? [], tests);

	const failures: TestFailureDetail[] = [];
	collectFailures(report.suites ?? [], failures);

	return {
		passed: failedCount === 0,
		totalTests,
		passedCount,
		failedCount,
		tests,
		failures,
		durationMs: stats.duration ?? 0,
		reportPath,
	};
}

type RunTestArgs = {
	filePath: string | null;
};

export const runTestTool: ToolDefinition<RunTestArgs, RunTestResult> = {
	name: 'run_test',
	description:
		"Run the Playwright test suite, optionally scoped to a single file. Returns structured pass/fail results with per-test failure details (error message, stack trace, and paths to a screenshot/trace/video if captured). A failure's pageSnapshotAtFailure, when present, is the real accessibility-tree snapshot of the page at the exact moment it failed — read it before writing rootCause or attempting a repair. It routinely shows the actual reason a locator never resolved (the element genuinely isn't there, a different element occupies that role/name, a dropdown never populated) that the bare error message and stack trace can't tell you on their own — a bare 'Test timeout of 90000ms exceeded' looks the same whether the page never loaded, the wrong selector was used, or the right selector needed something else (typed text, a wait) to ever appear. Do not guess which one it was; check the snapshot.",
	parameters: {
		type: 'object',
		properties: {
			filePath: {
				type: ['string', 'null'],
				description:
					'Path relative to the configured test directory (the same directory write_test_file writes into), to run only one file, or null to run the whole suite. Cannot point outside that directory.',
			},
		},
		required: ['filePath'],
	},
	async execute({filePath}, context) {
		const binPath = findPlaywrightBinary(context.projectRoot);
		if (!binPath) {
			return {
				ok: false,
				error:
					'@playwright/test is not installed. Run `npm install -D @playwright/test` in the project first.',
			};
		}

		const testDirResolution = resolveConfiguredDir(
			context.projectRoot,
			context.orbitConfig.testDir,
			'testDir',
		);
		if (!testDirResolution.ok) {
			return {ok: false, error: testDirResolution.error};
		}

		if (filePath) {
			const filePathResolution = resolveConfiguredDir(
				testDirResolution.path,
				filePath,
				'filePath',
			);
			if (!filePathResolution.ok) {
				return {ok: false, error: filePathResolution.error};
			}
		}

		if (context.orbitConfig.approvalMode === 'ask') {
			const approved = await context.requestApproval(
				`Run ${filePath ?? 'the test suite'}?`,
			);
			if (!approved) {
				return {ok: false, error: 'User declined the run'};
			}
		}

		const testDirAbsolute = testDirResolution.path;
		const orbitDir = getOrbitDir(context.projectRoot);
		const indexDir = path.join(orbitDir, 'index');
		fs.mkdirSync(indexDir, {recursive: true});

		// Scoped runs check just the one file being run; a whole-suite run
		// has to be conservative and check every known file, since one shared
		// config can't give different tests different storageState. See
		// anyKnownFileRequiresFreshSession's own reasoning for why "skip it
		// for the whole run" is the safe direction when in doubt.
		const needsFreshSession = filePath
			? fileRequiresFreshSession(context.projectRoot, testDirAbsolute, filePath)
			: anyKnownFileRequiresFreshSession(context.projectRoot);

		let storageStatePath: string | null = null;
		if (!needsFreshSession) {
			const authSetupResult = await runAuthSetupIfNeeded(
				binPath,
				context.projectRoot,
				context.orbitConfig.baseUrl,
				indexDir,
				context.signal,
			);
			if (!authSetupResult.ok) {
				return {ok: false, error: authSetupResult.error};
			}
			storageStatePath = authSetupResult.storageStatePath;
		}

		// A fresh, uniquely-named subfolder per run — Playwright cleans
		// outputDir at the start of every run, so a fixed shared path would
		// silently wipe out a prior run's screenshots/traces/videos (and
		// any session log or repair-loop step still referencing them).
		const runId = new Date().toISOString().replace(/[:.]/g, '-');
		const outputDirAbsolute = path.join(orbitDir, 'traces', runId);
		fs.mkdirSync(outputDirAbsolute, {recursive: true});

		const configPath = path.join(indexDir, 'playwright.config.mjs');
		fs.writeFileSync(
			configPath,
			buildOrbitPlaywrightConfigSource(
				testDirAbsolute,
				context.orbitConfig.baseUrl,
				outputDirAbsolute,
				storageStatePath,
			),
			'utf8',
		);

		// Same run-id folder as the trace artifacts, so a session log's
		// reportPath still resolves to a real file instead of one a later
		// run has since overwritten.
		const reportPath = path.join(outputDirAbsolute, 'report.json');

		const args = ['test', '--config', configPath, '--reporter=json'];
		if (filePath) {
			// Already validated above (before the approval prompt) — this
			// resolve is guaranteed to stay inside testDirAbsolute.
			args.push(path.resolve(testDirAbsolute, filePath));
		}

		try {
			await runPlaywrightProcess(
				binPath,
				args,
				context.projectRoot,
				{
					...process.env,
					PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
				},
				context.signal,
			);
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		if (!fs.existsSync(reportPath)) {
			return {
				ok: false,
				error:
					'Playwright did not produce a JSON report — the run may have failed to start.',
			};
		}

		try {
			const raw = fs.readFileSync(reportPath, 'utf8');
			return {ok: true, data: parsePlaywrightJsonReport(raw, reportPath)};
		} catch (error) {
			return {
				ok: false,
				error: `Failed to parse the Playwright report: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
	},
};
