import fs from 'node:fs';
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

// The one shared parent every blind workspace lives under — deliberately
// NOT under ~/.orbit/ (that's dot-prefixed and hidden by default in
// Finder/ls, which defeats the point for a workspace whose whole appeal is
// being easy to go look at) and, just as deliberately, the ONLY place a
// blind workspace is allowed to live (see isWithinBlindWorkspacesRoot) —
// every workspace's node_modules is a symlink onto this root's own single
// @playwright/test + Chromium install (see linkSharedPlaywright), so two
// blind projects never each download their own ~100MB Chromium copy.
export function getBlindWorkspacesRoot(): string {
	return path.join(os.homedir(), 'Orbit');
}

// Suggested as a starting point for the leaf folder name — the confirm step
// still lets the user rename that leaf (e.g. to dodge a collision or make
// it more readable than the auto-derived hostname-port slug), but
// isWithinBlindWorkspacesRoot enforces that it can only ever be a leaf
// *under* getBlindWorkspacesRoot(), never a path elsewhere.
export function suggestBlindStoragePath(projectName: string): string {
	return path.join(getBlindWorkspacesRoot(), projectName);
}

// Resolves the candidate (which may be relative, or carry a trailing slash,
// or use ".." segments) before comparing, so this can't be defeated by
// anything short of actually landing outside the root once resolved — same
// prefix-check shape as resolveConfiguredDir in init/config.ts.
export function isWithinBlindWorkspacesRoot(candidatePath: string): boolean {
	const root = getBlindWorkspacesRoot();
	const resolved = path.resolve(candidatePath);
	const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
	return resolved === root || resolved.startsWith(rootWithSep);
}

// Every blind workspace's own node_modules is a symlink onto the shared
// root's single install rather than its own copy — findPlaywrightBinary and
// isChromiumInstalled (runTest.ts / playwrightSetup.ts) only ever check
// <projectRoot>/node_modules directly, never walking up to a parent, so the
// symlink is what lets them resolve the shared install as if it were local.
// A no-op if this workspace already has a node_modules (already linked, or
// somehow a real one) or if the shared root has nothing to link to yet
// (install declined/failed) — in the latter case there's simply nothing to
// link, same degraded state a fresh non-shared install would have left.
export function linkSharedPlaywright(storageRoot: string): void {
	const sharedNodeModules = path.join(getBlindWorkspacesRoot(), 'node_modules');
	const localNodeModules = path.join(storageRoot, 'node_modules');

	if (fs.existsSync(localNodeModules) || !fs.existsSync(sharedNodeModules)) {
		return;
	}

	fs.symlinkSync(
		sharedNodeModules,
		localNodeModules,
		process.platform === 'win32' ? 'junction' : 'dir',
	);
}

export function isLikelyUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}
