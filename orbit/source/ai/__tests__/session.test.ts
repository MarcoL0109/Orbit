import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import type {OrbitConfig} from '../../init/config.js';
import type {FeatureResult} from '../tools/reportResult.js';
import {writeManualInputTestRecords} from '../session.js';

function makeTemporaryDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-session-'));
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
		...overrides,
	};
}

function manualFeatureResult(
	overrides: Partial<FeatureResult> = {},
): FeatureResult {
	return {
		feature: 'auth.login',
		file: null,
		status: 'passed',
		summary: 'Logged in using the emailed one-time code.',
		rootCause: null,
		explorationResult: 'passed',
		explorationReason: 'verified live',
		backendResult: 'confirmed-success',
		backendReason: 'checked the real response',
		playwrightStage: 'not-run',
		requiresManualInput: true,
		manualStepOutcome: 'succeeded',
		confidence: 'certain',
		...overrides,
	};
}

test('writes a record for each manual-input feature under manualTestDir', t => {
	const projectRoot = makeTemporaryDir();

	const result = writeManualInputTestRecords(projectRoot, fakeConfig(), [
		manualFeatureResult(),
	]);

	t.is(result.error, null);
	t.is(result.paths.length, 1);
	t.true(fs.existsSync(result.paths[0]!));
	t.true(
		result.paths[0]!.startsWith(
			path.join(projectRoot, 'Orbit-test/user_input_test'),
		),
	);
});

test('skips features that do not require manual input', t => {
	const projectRoot = makeTemporaryDir();

	const result = writeManualInputTestRecords(projectRoot, fakeConfig(), [
		manualFeatureResult({requiresManualInput: false}),
	]);

	t.is(result.error, null);
	t.deepEqual(result.paths, []);
});

test('rejects a manualTestDir that escapes projectRoot, writing nothing', t => {
	const projectRoot = makeTemporaryDir();

	const result = writeManualInputTestRecords(
		projectRoot,
		fakeConfig({manualTestDir: '../../etc'}),
		[manualFeatureResult()],
	);

	t.not(result.error, null);
	t.deepEqual(result.paths, []);
	t.deepEqual(fs.readdirSync(projectRoot), []);
});

test('rejects an absolute manualTestDir elsewhere on disk', t => {
	const projectRoot = makeTemporaryDir();

	const result = writeManualInputTestRecords(
		projectRoot,
		fakeConfig({manualTestDir: '/etc'}),
		[manualFeatureResult()],
	);

	t.not(result.error, null);
	t.deepEqual(result.paths, []);
});
