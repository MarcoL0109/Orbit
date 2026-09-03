import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import type {OrbitConfig} from '../../../init/config.js';
import type {ToolContext} from '../types.js';
import {runTestTool} from '../runTest.js';
import {writeTestFileTool} from '../writeTestFile.js';

function makeProjectRoot(): string {
	const projectRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), 'orbit-path-escape-'),
	);
	// Run_test bails out before any of this matters if the binary is
	// missing — give it one so the filePath check is actually reached.
	const binDir = path.join(projectRoot, 'node_modules', '.bin');
	fs.mkdirSync(binDir, {recursive: true});
	fs.writeFileSync(path.join(binDir, 'playwright'), '', 'utf8');
	return projectRoot;
}

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
		environmentSetupRoot: null,
		blind: false,
		headed: false,
		...overrides,
	};
}

// A stub for every ToolContext field this test's tools don't legitimately
// need — throwing rather than no-op means an escaping path that somehow
// slips past the guard and reaches one of these is a loud test failure, not
// a silent pass.
function fakeContext(
	projectRoot: string,
	orbitConfig: OrbitConfig,
): ToolContext {
	return {
		projectRoot,
		orbitConfig,
		signal: new AbortController().signal,
		requestApproval() {
			throw new Error('requestApproval should not be reached');
		},
		requestInput() {
			throw new Error('requestInput should not be reached');
		},
		hasExploredWithBrowser() {
			throw new Error('hasExploredWithBrowser should not be reached');
		},
		hasUnconsumedManualInput() {
			throw new Error('hasUnconsumedManualInput should not be reached');
		},
		getBrowserWorker() {
			throw new Error('getBrowserWorker should not be reached');
		},
		requestOutcomeConfirmation() {
			throw new Error('requestOutcomeConfirmation should not be reached');
		},
		hasConfirmedOutcome() {
			throw new Error('hasConfirmedOutcome should not be reached');
		},
		getCurrentExplorationNodeId() {
			throw new Error('getCurrentExplorationNodeId should not be reached');
		},
		setCurrentExplorationNodeId() {
			throw new Error('setCurrentExplorationNodeId should not be reached');
		},
		getSteps() {
			throw new Error('getSteps should not be reached');
		},
	};
}

test('run_test rejects a filePath that escapes the configured test directory', async t => {
	const projectRoot = makeProjectRoot();
	const orbitConfig = fakeConfig();

	const result = await runTestTool.execute(
		{filePath: '../../../etc/passwd'},
		fakeContext(projectRoot, orbitConfig),
	);

	t.false(result.ok);
	if (!result.ok) {
		t.regex(result.error, /filePath/);
	}

	// Nothing should have been created — the guard runs before any
	// directory/config/report scaffolding.
	t.false(fs.existsSync(path.join(projectRoot, '.orbit', 'index')));
	t.false(fs.existsSync(path.join(projectRoot, '.orbit', 'traces')));
});

test('run_test accepts a filePath that stays inside the test directory', async t => {
	const projectRoot = makeProjectRoot();
	const orbitConfig = fakeConfig();
	fs.mkdirSync(path.join(projectRoot, orbitConfig.testDir), {
		recursive: true,
	});

	// Doesn't assert on the final pass/fail result — the fake playwright
	// binary is an empty file, so the actual spawn will fail. This only
	// proves the path guard let a legitimate relative path through to the
	// point of actually attempting a run (i.e. it did not reject early).
	const result = await runTestTool.execute(
		{filePath: 'login.spec.ts'},
		fakeContext(projectRoot, orbitConfig),
	);

	if (!result.ok) {
		t.notRegex(result.error, /filePath/);
	}
});

test('write_test_file rejects a relativePath that escapes the configured test directory', async t => {
	const projectRoot = makeProjectRoot();
	const orbitConfig = fakeConfig();

	const result = await writeTestFileTool.execute(
		{
			relativePath: '../../../etc/passwd',
			content: 'test content',
			features: ['example'],
		},
		fakeContext(projectRoot, orbitConfig),
	);

	t.false(result.ok);
	if (!result.ok) {
		t.regex(result.error, /relativePath/);
	}

	t.false(fs.existsSync(path.join(projectRoot, 'etc')));
});

test('write_test_file accepts a relativePath that stays inside the test directory', async t => {
	const projectRoot = makeProjectRoot();
	const orbitConfig = fakeConfig();

	const result = await writeTestFileTool.execute(
		{
			relativePath: 'login.spec.ts',
			content: 'test content',
			features: ['example'],
		},
		fakeContext(projectRoot, orbitConfig),
	);

	t.true(result.ok);
	t.true(
		fs.existsSync(path.join(projectRoot, orbitConfig.testDir, 'login.spec.ts')),
	);
});
