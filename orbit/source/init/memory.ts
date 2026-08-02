import fs from 'node:fs';
import path from 'node:path';

export type ProjectMemory = {
    overview: string | null;
    decisions: string | null;
    failures: string | null;
};

const MAX_MEMORY_CHARS = 4000;

function getMemoryDir(projectRoot: string): string {
    return path.join(projectRoot, '.orbit', 'memory');
}

function readMemoryFile(projectRoot: string, fileName: string): string | null {
    const filePath = path.join(getMemoryDir(projectRoot), fileName);

    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf8').trim();

        if (!content) {
            return null;
        }

        return content.length <= MAX_MEMORY_CHARS
            ? content
            : `${content.slice(0, MAX_MEMORY_CHARS)}\n...(truncated)`;
    } catch {
        return null;
    }
}

// Read-only. Nothing writes back into these files yet — see failures.md's
// own placeholder text ("Orbit will record useful test failure patterns
// here"), which is aspirational, not implemented. That's a deliberate
// follow-on, not an oversight: deciding what's worth writing back, and
// guarding against the agent recording a wrong lesson that then poisons
// every future run reading it, needs its own scoping.
export function readProjectMemory(projectRoot: string): ProjectMemory {
    return {
        overview: readMemoryFile(projectRoot, 'overview.md'),
        decisions: readMemoryFile(projectRoot, 'decisions.md'),
        failures: readMemoryFile(projectRoot, 'failures.md'),
    };
}
