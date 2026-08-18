import process from 'node:process';
import test from 'ava';
import {runCi, type CiDeps} from '../ci.js';
import type {OrbitConfig} from '../init/config.js';
import type {ProjectMap} from '../projects/scan.js';
import type {AgentRunResult} from '../ai/agent.js';

// Fakes only — no real fs/network/OpenAI/process.exit calls. Covers the
// exit-code contract and the SIGINT/SIGTERM handling added to fix orphaned
// browser workers on a cancelled CI run; the pre-flight branching itself
// (bad project, wrong approval mode, unreachable) predates this change and
// isn't re-covered here.

function fakeConfig(overrides: Partial<OrbitConfig> = {}): OrbitConfig {
	return {
		approvalMode: 'always',
		defaultBrowser: 'chromium',
		baseUrl: 'http://localhost:3000',
		devCommands: [],
		testCommand: null,
		testDir: 'Orbit-test/e2e',
		manualTestDir: 'Orbit-test/user_input_test',
		writeMode: 'always',
		maxRepairAttempts: 3,
		dockerComposeFile: null,
		dockerComposeHasHealthchecks: false,
		scanMode: null,
		...overrides,
	};
}

function fakeProjectMap(): ProjectMap {
	return {
		generatedAt: new Date().toISOString(),
		projectRoot: '/fake/project',
		framework: null,
		packageManager: null,
		testFramework: null,
		scripts: {},
		files: [],
		routes: [],
		components: [],
		tests: [],
		commands: [],
		aiFiles: [],
		projectLogicFiles: [],
		typeFiles: [],
		utilityFiles: [],
		configs: [],
		filesScanned: 0,
		checksumDiff: {added: [], changed: [], unchanged: [], deleted: []},
	};
}

// A no-op that satisfies CiDeps' `never`-returning exit signature without
// actually terminating the test process — tests that care what code it was
// called with override this individually.
const noopExit = ((_code: number) => {}) as unknown as (code: number) => never;

function preflightOkDeps(): Partial<CiDeps> {
	return {
		detectProjectRoot: () => ({
			isProject: true,
			root: '/fake/project',
			confidence: 100,
			markers: [],
			hasOrbitFolder: true,
		}),
		readOrbitConfig: () => fakeConfig(),
		isReachable: async () => true,
		async scanProjectWithModeSelection() {
			return {
				projectMap: fakeProjectMap(),
				graphifyOutcome: {status: 'skipped'},
			};
		},
		writeProjectMap: () => '',
		writeAgentSession: () => '',
		writeManualInputTestRecords: () => [],
		log() {},
		logError() {},
		exit: noopExit,
	};
}

function agentResult(
	status: AgentRunResult['status'],
	overrides: Partial<AgentRunResult> = {},
): AgentRunResult {
	return {status, summary: 'summary', results: [], steps: [], ...overrides};
}

test.serial('exit code 0 when every feature passed', async t => {
	const exitCode = await runCi('a feature', {
		...preflightOkDeps(),
		async runTestingAgent() {
			return agentResult('passed');
		},
	});

	t.is(exitCode, 0);
});

for (const status of ['failed', 'gave_up'] as const) {
	test.serial(`exit code 1 when the agent reports ${status}`, async t => {
		const exitCode = await runCi('a feature', {
			...preflightOkDeps(),
			async runTestingAgent() {
				return agentResult(status);
			},
		});

		t.is(exitCode, 1);
	});
}

test.serial(
	'exit code 2 (not 1) when the run was aborted rather than actually failing',
	async t => {
		const exitCode = await runCi('a feature', {
			...preflightOkDeps(),
			async runTestingAgent() {
				return agentResult('aborted');
			},
		});

		t.is(exitCode, 2);
	},
);

test.serial(
	'a SIGINT during the run aborts the AbortSignal passed to runTestingAgent',
	async t => {
		let observedAborted = false;

		await runCi('a feature', {
			...preflightOkDeps(),
			async runTestingAgent(_prompt, context) {
				t.false(context.signal.aborted);
				process.emit('SIGINT');
				observedAborted = context.signal.aborted;
				return agentResult('aborted');
			},
		});

		t.true(observedAborted);
	},
);

test.serial(
	'a first SIGINT does not force-exit, only a second one does',
	async t => {
		const exitCalls: number[] = [];
		const fakeExit = ((code: number) => {
			exitCalls.push(code);
		}) as unknown as (code: number) => never;

		await runCi('a feature', {
			...preflightOkDeps(),
			exit: fakeExit,
			async runTestingAgent() {
				process.emit('SIGINT');
				t.deepEqual(exitCalls, []);
				process.emit('SIGINT');
				t.deepEqual(exitCalls, [2]);
				return agentResult('aborted');
			},
		});

		t.deepEqual(exitCalls, [2]);
	},
);

test.serial(
	'SIGINT/SIGTERM listeners are removed once the run finishes, pass or fail',
	async t => {
		const sigintBefore = process.listenerCount('SIGINT');
		const sigtermBefore = process.listenerCount('SIGTERM');

		await runCi('a feature', {
			...preflightOkDeps(),
			async runTestingAgent() {
				return agentResult('passed');
			},
		});

		t.is(process.listenerCount('SIGINT'), sigintBefore);
		t.is(process.listenerCount('SIGTERM'), sigtermBefore);

		await runCi('a feature', {
			...preflightOkDeps(),
			async runTestingAgent() {
				throw new Error('boom');
			},
		});

		t.is(process.listenerCount('SIGINT'), sigintBefore);
		t.is(process.listenerCount('SIGTERM'), sigtermBefore);
	},
);

test.serial(
	'--json mode: stdout gets exactly one JSON line, progress goes to stderr instead',
	async t => {
		const stdoutLines: string[] = [];
		const stderrLines: string[] = [];

		const exitCode = await runCi(
			'a feature',
			{
				...preflightOkDeps(),
				log(message) {
					stdoutLines.push(message);
				},
				logError(message) {
					stderrLines.push(message);
				},
				async runTestingAgent(_prompt, _context, {onProgress} = {}) {
					onProgress?.({name: 'browser_action'});
					return agentResult('passed');
				},
			},
			{json: true},
		);

		t.is(exitCode, 0);
		t.is(stdoutLines.length, 1);
		const payload = JSON.parse(stdoutLines[0]!) as Record<string, unknown>;
		t.is(payload['status'], 'passed');
		t.is(payload['exitCode'], 0);
		t.deepEqual(payload['features'], []);

		// The progress line and formatAgentRunResult's own text both went
		// through the aliased log — i.e. to stderr — not stdout.
		t.true(stderrLines.length > 0);
	},
);

test.serial(
	'--json mode: a pre-flight failure still emits one JSON line, shaped as an error',
	async t => {
		const stdoutLines: string[] = [];

		const exitCode = await runCi(
			'a feature',
			{
				...preflightOkDeps(),
				log(message) {
					stdoutLines.push(message);
				},
				logError() {},
				isReachable: async () => false,
			},
			{json: true},
		);

		t.is(exitCode, 2);
		t.is(stdoutLines.length, 1);
		const payload = JSON.parse(stdoutLines[0]!) as Record<string, unknown>;
		t.is(payload['status'], 'error');
		t.is(payload['exitCode'], 2);
		t.true(typeof payload['error'] === 'string');
	},
);
