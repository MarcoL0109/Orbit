import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Candidates checked in priority order — uv is fastest and what the rest
// of this codebase already reaches for (see runCommand.ts's own live
// testing against uv-based projects), pipx and pip are the documented
// fallbacks graphify itself lists.
const INSTALL_CANDIDATES: Array<{tool: string; args: string[]}> = [
	{tool: 'uv', args: ['tool', 'install', 'graphifyy']},
	{tool: 'pipx', args: ['install', 'graphifyy']},
	{tool: 'pip3', args: ['install', 'graphifyy']},
	{tool: 'pip', args: ['install', 'graphifyy']},
];

function commandExists(command: string): boolean {
	const result = spawnSync(command, ['--version'], {stdio: 'ignore'});
	return !result.error;
}

export function isGraphifyAvailable(): boolean {
	const result = spawnSync('graphify', ['--help'], {stdio: 'ignore'});
	return !result.error;
}

function pickInstallCommand(): {tool: string; args: string[]} | null {
	return (
		INSTALL_CANDIDATES.find(candidate => commandExists(candidate.tool)) ?? null
	);
}

export type InstallGraphifyResult =
	| {installed: true}
	| {installed: false; reason: string};

// Approval is the caller's job (via requestApproval), not this function's —
// keeps this a pure "do the install" step, testable without a UI.
export function installGraphify(): InstallGraphifyResult {
	const picked = pickInstallCommand();

	if (!picked) {
		return {
			installed: false,
			reason:
				'No package manager found (checked uv, pipx, pip3, pip) — install graphify manually: https://github.com/Graphify-Labs/graphify',
		};
	}

	const result = spawnSync(picked.tool, picked.args, {encoding: 'utf8'});

	if (result.error || result.status !== 0) {
		const detail =
			result.stderr?.trim() ||
			result.error?.message ||
			`exit code ${result.status}`;
		return {
			installed: false,
			reason: `${picked.tool} ${picked.args.join(' ')} failed: ${detail}`,
		};
	}

	return isGraphifyAvailable()
		? {installed: true}
		: {
				installed: false,
				reason: `${picked.tool} reported success but 'graphify' still isn't on PATH — it may need a shell restart.`,
		  };
}

export type GraphifyScanResult =
	| {ok: true; mode: 'extract' | 'update'; summary: string}
	| {ok: false; error: string};

// Deliberately never redirected via --out: --out only exists on `extract`,
// not `update`, and testing it directly (moving output into .orbit/index/)
// broke graphify's own incremental caching entirely — a re-run with no
// source changes re-extracted every file instead of reporting "cached,
// unchanged". Left at graphify's own default (<projectRoot>/graphify-out/),
// incremental caching works correctly; ensureGraphifyGitignored keeps it
// out of version control instead.
export function runGraphifyScan(projectRoot: string): GraphifyScanResult {
	const graphPath = path.join(projectRoot, 'graphify-out', 'graph.json');
	const hasExistingGraph = fs.existsSync(graphPath);
	const mode: 'extract' | 'update' = hasExistingGraph ? 'update' : 'extract';

	const args =
		mode === 'extract' ? ['extract', '.', '--code-only'] : ['update', '.'];
	const result = spawnSync('graphify', args, {
		cwd: projectRoot,
		encoding: 'utf8',
	});

	if (result.error || result.status !== 0) {
		const detail =
			result.stderr?.trim() ||
			result.error?.message ||
			`exit code ${result.status}`;
		return {ok: false, error: `graphify ${args.join(' ')} failed: ${detail}`};
	}

	ensureGraphifyGitignored(projectRoot);

	const lines = (result.stdout ?? '').split('\n');
	// Extract's own success line ("wrote .../graph.json: N nodes...") is
	// the clearest signal when present; update instead prints a
	// "[graphify watch] Rebuilt: ..." or "...no changes..." status line.
	// Either beats the fallback, which is real output but not a status
	// line — e.g. a static "Tip: set GEMINI_API_KEY..." footer that update
	// always prints regardless of what actually happened this run.
	const summaryLine =
		lines.find(line => line.includes('wrote') && line.includes('graph.json')) ??
		lines.find(line => line.includes('[graphify watch]')) ??
		lines
			.map(line => line.trim())
			.reverse()
			.find(line => line && !line.startsWith('Tip:')) ??
		'graph updated';

	return {ok: true, mode, summary: summaryLine.trim()};
}

// Only edits a .gitignore that already exists — a project with none at all
// might not even be a git repo, and creating one just for this single
// entry would be presumptuous.
export function ensureGraphifyGitignored(projectRoot: string): void {
	const gitignorePath = path.join(projectRoot, '.gitignore');

	if (!fs.existsSync(gitignorePath)) {
		return;
	}

	try {
		const content = fs.readFileSync(gitignorePath, 'utf8');
		const alreadyIgnored = content
			.split('\n')
			.some(line => line.trim().replace(/\/$/, '') === 'graphify-out');

		if (!alreadyIgnored) {
			const separator = content.endsWith('\n') || content === '' ? '' : '\n';
			fs.writeFileSync(
				gitignorePath,
				`${content}${separator}graphify-out/\n`,
				'utf8',
			);
		}
	} catch {
		// Non-fatal — the graph itself is still built and usable even if
		// this housekeeping edit fails.
	}
}
