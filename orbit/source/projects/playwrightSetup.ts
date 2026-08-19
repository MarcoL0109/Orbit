import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {findPlaywrightBinary} from '../ai/tools/runTest.js';

export function isPlaywrightPackageInstalled(projectRoot: string): boolean {
	return findPlaywrightBinary(projectRoot) !== null;
}

// ExecutablePath() is a synchronous, no-launch lookup — @playwright/test
// computes the path its pinned Chromium revision would live at whether or
// not it's actually there yet, so this is just an fs.existsSync check away
// from a real answer, no browser process involved. Resolved via the
// project's own node_modules (not Orbit's — Orbit itself has no playwright
// dependency), the same way Node would resolve it from a file living at
// projectRoot.
// Not the real @playwright/test types — Orbit itself has no dependency on
// the package (it only ever lives in the target project's node_modules,
// resolved dynamically below), so only the one method actually used here
// is declared.
type PlaywrightTestModule = {
	chromium: {executablePath(): string};
};

function isChromiumInstalled(projectRoot: string): boolean {
	try {
		const require = createRequire(path.join(projectRoot, 'package.json'));
		const {chromium} = require('@playwright/test') as PlaywrightTestModule;
		return fs.existsSync(chromium.executablePath());
	} catch {
		return false;
	}
}

export type InstallPlaywrightResult =
	| {installed: true}
	| {installed: false; reason: string};

// Same split as installGraphify: approval is the caller's job, this just
// does the install and reports what happened.
function installPlaywrightPackage(
	projectRoot: string,
): InstallPlaywrightResult {
	const result = spawnSync('npm', ['install', '-D', '@playwright/test'], {
		cwd: projectRoot,
		encoding: 'utf8',
	});

	if (result.error || result.status !== 0) {
		const detail =
			result.stderr?.trim() ||
			result.error?.message ||
			`exit code ${result.status}`;
		return {
			installed: false,
			reason: `npm install -D @playwright/test failed: ${detail}`,
		};
	}

	return isPlaywrightPackageInstalled(projectRoot)
		? {installed: true}
		: {
				installed: false,
				reason:
					'npm reported success but node_modules/.bin/playwright is still missing.',
		  };
}

function installChromiumBrowser(projectRoot: string): InstallPlaywrightResult {
	const binPath = findPlaywrightBinary(projectRoot);
	if (!binPath) {
		return {
			installed: false,
			reason: '@playwright/test must be installed before its browsers can be.',
		};
	}

	const result = spawnSync(binPath, ['install', 'chromium'], {
		cwd: projectRoot,
		encoding: 'utf8',
	});

	if (result.error || result.status !== 0) {
		const detail =
			result.stderr?.trim() ||
			result.error?.message ||
			`exit code ${result.status}`;
		return {
			installed: false,
			reason: `playwright install chromium failed: ${detail}`,
		};
	}

	return isChromiumInstalled(projectRoot)
		? {installed: true}
		: {
				installed: false,
				reason:
					"playwright reported success but the Chromium executable still can't be found.",
		  };
}

export type PlaywrightSetupOutcome =
	| {status: 'already-ready'}
	| {status: 'installed'}
	| {status: 'declined'}
	| {status: 'failed'; error: string};

export type PlaywrightSetupDeps = {
	requestApproval: (description: string) => Promise<boolean>;
};

// Mirrors resolveScanModeChoice's shape (scanOrchestration.ts): check →
// requestApproval → install → report. Run_test can't do anything without
// both @playwright/test and its Chromium browser, so /init is where this
// gets caught — before the user is deep into writing a feature prompt.
export async function ensurePlaywrightSetup(
	projectRoot: string,
	deps: PlaywrightSetupDeps,
): Promise<PlaywrightSetupOutcome> {
	const hasPackage = isPlaywrightPackageInstalled(projectRoot);
	const hasChromium = hasPackage && isChromiumInstalled(projectRoot);

	if (hasPackage && hasChromium) {
		return {status: 'already-ready'};
	}

	const missingParts = [
		!hasPackage && '@playwright/test',
		!hasChromium && 'the Chromium browser',
	].filter((part): part is string => Boolean(part));

	const approved = await deps.requestApproval(
		`Orbit needs ${missingParts.join(
			' and ',
		)} installed in this project to run generated tests (npm install -D @playwright/test${
			hasChromium ? '' : ' && npx playwright install chromium'
		}). Install ${missingParts.length > 1 ? 'them' : 'it'} now?`,
	);

	if (!approved) {
		return {status: 'declined'};
	}

	if (!hasPackage) {
		const packageResult = installPlaywrightPackage(projectRoot);
		if (!packageResult.installed) {
			return {status: 'failed', error: packageResult.reason};
		}
	}

	const chromiumResult = installChromiumBrowser(projectRoot);
	if (!chromiumResult.installed) {
		return {status: 'failed', error: chromiumResult.reason};
	}

	return {status: 'installed'};
}

// Formats a PlaywrightSetupOutcome for display, or null when there's
// nothing worth showing (already-ready) — mirrors graphifyOutcomeMessage.
export function playwrightSetupOutcomeMessage(
	outcome: PlaywrightSetupOutcome,
): {content: string; color: string} | null {
	if (outcome.status === 'installed') {
		return {
			content: 'Playwright and Chromium installed.',
			color: 'green',
		};
	}

	if (outcome.status === 'declined') {
		return {
			content:
				'Skipped — Orbit will need @playwright/test and Chromium installed before it can run a generated test. Run /init again any time to reconsider.',
			color: 'yellow',
		};
	}

	if (outcome.status === 'failed') {
		return {
			content: `Playwright setup failed: ${outcome.error}`,
			color: 'yellow',
		};
	}

	return null;
}
