import os from 'node:os';
import path from 'node:path';

// A readable stand-in for a project name until the user picks (or edits)
// something better — hostname (+ port, when present), lowercased, with
// anything that isn't filesystem/URL-safe collapsed to a dash. The port
// matters in practice, not just in theory: multiple local dev services
// (a frontend, a backend, a handful of unrelated projects) all sit on
// "localhost" and are only distinguished by which port they're on —
// hostname alone collapsed them all onto the same "localhost" name.
export function deriveBlindProjectName(targetUrl: string): string {
	let identity: string;

	try {
		const parsed = new URL(targetUrl);
		identity = parsed.port
			? `${parsed.hostname}-${parsed.port}`
			: parsed.hostname;
	} catch {
		identity = targetUrl;
	}

	const slug = identity
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');

	return slug || 'blind-project';
}

// Orbit's own directory, not the target's — there is no target directory in
// blind mode. Suggested, not forced: the confirm step lets the user pick
// somewhere else before anything is written. Deliberately NOT under
// ~/.orbit/ — that's dot-prefixed and hidden by default in Finder/ls, which
// defeats the point for a workspace whose whole appeal is being easy to go
// look at (config, memory, the generated test, all in one visible place).
export function suggestBlindStoragePath(projectName: string): string {
	return path.join(os.homedir(), 'Orbit', projectName);
}

export function isLikelyUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}
