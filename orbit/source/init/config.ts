import fs from 'node:fs';
import path from 'node:path';

// 'ask' prompts the user (via the Ink UI) before the action; 'always' skips
// the prompt and proceeds automatically.
export type ApprovalMode = 'ask' | 'always';

export type OrbitConfig = {
    approvalMode: ApprovalMode;
    defaultBrowser: string;
    baseUrl: string;
    devCommand: string | null;
    testCommand: string | null;
    testDir: string;
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
