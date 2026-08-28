import fs from 'node:fs';
import path from 'node:path';
import {resolveConfiguredDir, type OrbitConfig} from '../init/config.js';
import {getOrbitDir} from '../init/orbitDir.js';
import type {AgentRunResult} from './agent.js';
import type {FeatureResult} from './tools/reportResult.js';

export function writeAgentSession(
	projectRoot: string,
	prompt: string,
	result: AgentRunResult,
): string {
	const sessionsDir = path.join(getOrbitDir(projectRoot), 'sessions');
	fs.mkdirSync(sessionsDir, {recursive: true});

	const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
	const sessionPath = path.join(sessionsDir, fileName);

	fs.writeFileSync(
		sessionPath,
		JSON.stringify({prompt, ...result}, null, 2),
		'utf8',
	);
	return sessionPath;
}

function sanitizeFeatureFilename(feature: string): string {
	return feature.replace(/[^\w.-]/g, '_');
}

export type ManualInputRecordsResult = {
	paths: string[];
	// Non-null only when manualTestDir was configured (typically by hand
	// editing config.json — it isn't exposed in the interactive /config
	// editor) to something that escapes projectRoot. Nothing is written in
	// that case: the whole point is refusing to create directories or write
	// files at an arbitrary filesystem location.
	error: string | null;
};

// One .md record per manual-input feature, overwritten on each run rather
// than accumulated — same "latest write wins" behavior as the actual .spec
// files write_test_file produces. Not a runnable test: these features never
// get one (see write_test_file's rules), so there's nothing to execute —
// this is a human-readable record of what was verified live and how it went.
export function writeManualInputTestRecords(
	projectRoot: string,
	orbitConfig: OrbitConfig,
	results: FeatureResult[],
): ManualInputRecordsResult {
	const manualResults = results.filter(result => result.requiresManualInput);
	if (manualResults.length === 0) return {paths: [], error: null};

	// Falls back rather than crashing on a project whose config.json
	// predates this field (path.resolve throws on undefined) — caught
	// live testing against Redemption, whose .orbit/config.json was
	// written before manualTestDir existed.
	const manualTestDirResolution = resolveConfiguredDir(
		projectRoot,
		orbitConfig.manualTestDir ?? 'Orbit-test/user_input_test',
		'manualTestDir',
	);
	if (!manualTestDirResolution.ok) {
		return {paths: [], error: manualTestDirResolution.error};
	}

	const manualTestDir = manualTestDirResolution.path;
	fs.mkdirSync(manualTestDir, {recursive: true});

	const now = new Date().toISOString();

	const paths = manualResults.map(result => {
		const filePath = path.join(
			manualTestDir,
			`${sanitizeFeatureFilename(result.feature)}.md`,
		);
		const content = `# ${result.feature}

- Status: ${result.status}
- Manual step outcome: ${result.manualStepOutcome ?? 'unknown'}
- Verified: ${now}

## Summary

${result.summary}
`;
		fs.writeFileSync(filePath, content, 'utf8');
		return filePath;
	});

	return {paths, error: null};
}
