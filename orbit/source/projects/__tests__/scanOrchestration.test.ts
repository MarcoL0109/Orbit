import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {scanProjectWithModeSelection} from '../scanOrchestration.js';
import {
	writeOrbitConfig,
	readOrbitConfig,
	type OrbitConfig,
} from '../../init/config.js';

// Real temp directories, not mocked fs — scanProject/readOrbitConfig/
// writeOrbitConfig all do real file I/O with no injection seam, and faking
// that out would test the fake instead of the real read/write path. An
// empty directory scans cleanly (zero files found), so this stays fast and
// fully hermetic — no network, no subprocess, nothing external.
function makeProjectRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-scan-orchestration-'));
}

function baseConfig(overrides: Partial<OrbitConfig> = {}): OrbitConfig {
	return {
		approvalMode: 'ask',
		defaultBrowser: 'chromium',
		baseUrl: 'http://localhost:3000',
		devCommands: [],
		testCommand: null,
		testDir: 'Orbit-test/e2e',
		manualTestDir: 'Orbit-test/user_input_test',
		writeMode: 'ask',
		maxRepairAttempts: 3,
		dockerComposeFile: null,
		dockerComposeHasHealthchecks: false,
		scanMode: null,
		...overrides,
	};
}

test('with no .orbit config at all, never asks for a scan mode', async t => {
	const projectRoot = makeProjectRoot();
	let askedScanMode = false;

	await scanProjectWithModeSelection(projectRoot, {
		requestApproval: async () => true,
		async requestScanMode() {
			askedScanMode = true;
			return 'regex';
		},
		setMessages() {},
	});

	t.false(askedScanMode);
});

test('scanMode: null asks once and persists "regex" without touching install/approval', async t => {
	const projectRoot = makeProjectRoot();
	fs.mkdirSync(path.join(projectRoot, '.orbit'), {recursive: true});
	writeOrbitConfig(projectRoot, baseConfig({scanMode: null}));

	let askedApproval = false;

	await scanProjectWithModeSelection(projectRoot, {
		async requestApproval() {
			askedApproval = true;
			return true;
		},
		requestScanMode: async () => 'regex',
		setMessages() {},
	});

	t.is(readOrbitConfig(projectRoot)?.scanMode, 'regex');
	t.false(askedApproval);
});

test('a config predating the scanMode field (undefined, not null) is treated the same as null', async t => {
	const projectRoot = makeProjectRoot();
	fs.mkdirSync(path.join(projectRoot, '.orbit'), {recursive: true});
	const {scanMode: _drop, ...withoutScanMode} = baseConfig();
	fs.writeFileSync(
		path.join(projectRoot, '.orbit', 'config.json'),
		JSON.stringify(withoutScanMode, null, 2),
		'utf8',
	);

	let askedScanMode = false;

	await scanProjectWithModeSelection(projectRoot, {
		requestApproval: async () => true,
		async requestScanMode() {
			askedScanMode = true;
			return 'regex';
		},
		setMessages() {},
	});

	t.true(askedScanMode);
});

test('an already-persisted "regex" choice is never re-asked', async t => {
	const projectRoot = makeProjectRoot();
	fs.mkdirSync(path.join(projectRoot, '.orbit'), {recursive: true});
	writeOrbitConfig(projectRoot, baseConfig({scanMode: 'regex'}));

	let askedScanMode = false;

	await scanProjectWithModeSelection(projectRoot, {
		requestApproval: async () => true,
		async requestScanMode() {
			askedScanMode = true;
			return 'regex';
		},
		setMessages() {},
	});

	t.false(askedScanMode);
});
