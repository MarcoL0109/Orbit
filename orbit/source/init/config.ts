import fs from 'node:fs';
import path from 'node:path';

// 'ask' prompts the user (via the Ink UI) before the action; 'always' skips
// the prompt and proceeds automatically.
export type ApprovalMode = 'ask' | 'always';

export type OrbitConfig = {
	approvalMode: ApprovalMode;
	defaultBrowser: string;
	baseUrl: string;
	// Each entry is spawned as its own independent long-running process, not
	// chained together — bringing a dev stack up often means several things
	// that each run forever (docker compose up, a backend's own dev server)
	// rather than one command that completes before the next starts. Empty
	// when nothing was auto-detected and nothing has been configured.
	devCommands: string[];
	testCommand: string | null;
	testDir: string;
	// Where a record of a feature that needed request_user_input gets
	// written — a .md summary, not a runnable test, since there's nothing
	// to execute unattended for these (see write_test_file/report_result's
	// rules). Independent of testDir rather than derived from it, so it
	// stays predictable even if testDir is customized to something not
	// shaped like "Orbit-test/e2e".
	manualTestDir: string;
	writeMode: ApprovalMode;
	maxRepairAttempts: number;
	// Detected at /init — facts only, no strategy decided from them yet.
	// Path (relative to projectRoot) of a detected docker-compose file, or
	// null if none was found.
	dockerComposeFile: string | null;
	// Whether any service in that file declares a healthcheck — a future
	// phase can use this to check `docker compose ps` health status as a
	// readiness signal instead of guessing via HTTP polling. Always false
	// when dockerComposeFile is null.
	dockerComposeHasHealthchecks: boolean;
	// Null means "not yet chosen" — the user is asked once, on whatever
	// scan happens first for this project, and the answer is persisted
	// here so they're never asked again. See scanOrchestration.ts.
	scanMode: 'regex' | 'graphify' | null;
};

export function getOrbitConfigPath(projectRoot: string): string {
	return path.join(projectRoot, '.orbit', 'config.json');
}

export function readOrbitConfig(projectRoot: string): OrbitConfig | null {
	const configPath = getOrbitConfigPath(projectRoot);

	if (!fs.existsSync(configPath)) {
		return null;
	}

	try {
		return JSON.parse(fs.readFileSync(configPath, 'utf8')) as OrbitConfig;
	} catch {
		return null;
	}
}

export function writeOrbitConfig(
	projectRoot: string,
	config: OrbitConfig,
): void {
	fs.writeFileSync(
		getOrbitConfigPath(projectRoot),
		JSON.stringify(config, null, 2),
		'utf8',
	);
}
