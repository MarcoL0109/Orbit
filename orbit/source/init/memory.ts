import fs from 'node:fs';
import path from 'node:path';
import {getOrbitDir} from './orbitDir.js';

export type ProjectMemory = {
	overview: string | null;
	decisions: string | null;
	enviornment: string | null;
	failures: string | null;
};

const MAX_MEMORY_CHARS = 4000;

function getMemoryDir(projectRoot: string): string {
	return path.join(getOrbitDir(projectRoot), 'memory');
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
		enviornment: readMemoryFile(projectRoot, 'environment_setup.md'),
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

// Called by report_result when a feature ends 'failed' or 'gave_up' — the
// one thing failures.md was scaffolded for at /init but, until now, nothing
// ever wrote back to (see readProjectMemory's comment above). Entries are
// prepended, not appended: readMemoryFile's MAX_MEMORY_CHARS cap reads from
// the START of the file, so newest-first is what keeps recent failures
// inside that window as this file grows, rather than the oldest entries
// squatting there forever. Writes rootCause, not summary — report_result
// requires rootCause to be a specific, evidence-backed diagnosis (checked
// in reportResult.ts) rather than a vague recap, since a vague note here is
// exactly as useless to a future run as no note at all. Never raw logs or
// stack traces either way, matching this file's own placeholder guidance
// ("Do not store ... full raw logs").
export function recordFailureNote(
	projectRoot: string,
	entry: {feature: string; status: 'failed' | 'gave_up'; rootCause: string},
): void {
	const dir = getMemoryDir(projectRoot);
	fs.mkdirSync(dir, {recursive: true});
	const filePath = path.join(dir, 'failures.md');

	const existing = fs.existsSync(filePath)
		? fs.readFileSync(filePath, 'utf8').trim()
		: '';
	const date = new Date().toISOString().slice(0, 10);
	const note = `- **${date}** — "${entry.feature}" (${entry.status}): ${entry.rootCause}`;

	fs.writeFileSync(
		filePath,
		existing ? `${note}\n${existing}\n` : `${note}\n`,
		'utf8',
	);
}

// Called when a run that followed documented instructions still failed
// (gave up, or signaled ready but the app never became reachable) — that's
// strong evidence the recipe is stale (a changed port, a new required step,
// etc.), so it's deleted rather than left to keep failing every future run
// the same way. force:true makes this a no-op if the file is already gone.
export function invalidateEnvironmentSetupInstructions(
	projectRoot: string,
): void {
	fs.rmSync(path.join(getMemoryDir(projectRoot), 'environment_setup.md'), {
		force: true,
	});
}
