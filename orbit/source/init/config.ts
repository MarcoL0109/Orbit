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
