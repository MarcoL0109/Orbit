import fs from 'node:fs';
import path from 'node:path';
import type {OrbitConfig} from '../init/config.js';
import type {AgentRunResult} from './agent.js';
import type {FeatureResult} from './tools/reportResult.js';

export function writeAgentSession(
	projectRoot: string,
	prompt: string,
	result: AgentRunResult,
): string {
	const sessionsDir = path.join(projectRoot, '.orbit', 'sessions');
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

// One .md record per manual-input feature, overwritten on each run rather
// than accumulated — same "latest write wins" behavior as the actual .spec
// files write_test_file produces. Not a runnable test: these features never
// get one (see write_test_file's rules), so there's nothing to execute —
// this is a human-readable record of what was verified live and how it went.
export function writeManualInputTestRecords(
	projectRoot: string,
	orbitConfig: OrbitConfig,
	results: FeatureResult[],
): string[] {
	const manualResults = results.filter(result => result.requiresManualInput);
	if (manualResults.length === 0) return [];

	// Falls back rather than crashing on a project whose config.json
	// predates this field (path.resolve throws on undefined) — caught
	// live testing against Redemption, whose .orbit/config.json was
	// written before manualTestDir existed.
	const manualTestDir = path.resolve(
		projectRoot,
		orbitConfig.manualTestDir ?? 'Orbit-test/user_input_test',
	);
	fs.mkdirSync(manualTestDir, {recursive: true});

	const now = new Date().toISOString();

	return manualResults.map(result => {
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
}
