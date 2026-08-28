import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {resolveConfiguredDir} from '../../init/config.js';
import {getOrbitDir} from '../../init/orbitDir.js';
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
): string {
	return `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: ${JSON.stringify(testDirAbsolute)},
  outputDir: ${JSON.stringify(outputDirAbsolute)},
  use: {
    baseURL: ${JSON.stringify(baseUrl)},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
`;
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

		// A fresh, uniquely-named subfolder per run — Playwright cleans
		// outputDir at the start of every run, so a fixed shared path would
		// silently wipe out a prior run's screenshots/traces/videos (and
		// any session log or repair-loop step still referencing them).
		const runId = new Date().toISOString().replace(/[:.]/g, '-');
		const outputDirAbsolute = path.join(orbitDir, 'traces', runId);
		fs.mkdirSync(indexDir, {recursive: true});
		fs.mkdirSync(outputDirAbsolute, {recursive: true});

		const configPath = path.join(indexDir, 'playwright.config.mjs');
		fs.writeFileSync(
			configPath,
			buildOrbitPlaywrightConfigSource(
				testDirAbsolute,
				context.orbitConfig.baseUrl,
				outputDirAbsolute,
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
