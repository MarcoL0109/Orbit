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

// Kept separate from ProjectMemory rather than folded into it — this file
// is specific to the environment setup agent (user-authored, exact startup
// commands to follow directly), not general testing context, so it's read
// and injected into a different agent's prompt entirely.
export function readEnvironmentSetupInstructions(
	projectRoot: string,
): string | null {
	return readMemoryFile(projectRoot, 'environment_setup.md');
}

// Called only when the environment setup agent had no instructions to
// follow and worked the sequence out itself — see commands.ts, which only
// calls this when readEnvironmentSetupInstructions returned null before the
// run, so a human-authored file is never overwritten by the agent's own
// reconstruction of it.
export function writeEnvironmentSetupInstructions(
	projectRoot: string,
	content: string,
): void {
	const dir = getMemoryDir(projectRoot);
	fs.mkdirSync(dir, {recursive: true});
	fs.writeFileSync(
		path.join(dir, 'environment_setup.md'),
		content.trim() + '\n',
		'utf8',
	);
}
