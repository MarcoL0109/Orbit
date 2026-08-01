import fs from 'node:fs';
import path from 'node:path';
import type { AgentRunResult } from './agent.js';

export function writeAgentSession(projectRoot: string, prompt: string, result: AgentRunResult): string {
    const sessionsDir = path.join(projectRoot, '.orbit', 'sessions');
    fs.mkdirSync(sessionsDir, {recursive: true});

    const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const sessionPath = path.join(sessionsDir, fileName);

    fs.writeFileSync(sessionPath, JSON.stringify({prompt, ...result}, null, 2), 'utf8');
    return sessionPath;
}
