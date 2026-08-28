import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

type ProjectDetectionResult = {
	isProject: boolean;
	root: string | null;
	confidence: number;
	markers: string[];
	packageManager?: 'pnpm' | 'npm' | 'yarn' | 'bun';
	framework?: string;
	testFramework?: string;
	hasOrbitFolder: boolean;
};

const ROOT_MARKERS = [
	'.orbit',
	// A blind-mode project's own Orbit folder (see orbitDir.ts) — the same
	// marker as '.orbit', just for a workspace that has no other content to
	// hide it from.
	'orbit',
	'orbit.config.ts',
	'orbit.config.js',
	'package.json',
	'playwright.config.ts',
	'playwright.config.js',
	'playwright.config.mts',
	'cypress.config.ts',
	'cypress.config.js',
	'next.config.ts',
	'next.config.js',
	'vite.config.ts',
	'vite.config.js',
	'.git',
];

const SUPPORTING_MARKERS = [
	'src',
	'app',
	'pages',
	'tests',
	'e2e',
	'pnpm-lock.yaml',
	'package-lock.json',
	'yarn.lock',
	'bun.lockb',
];

function exists(dir: string, name: string): boolean {
	return fs.existsSync(path.join(dir, name));
}

function getMarkers(dir: string): string[] {
	return [...ROOT_MARKERS, ...SUPPORTING_MARKERS].filter(marker =>
		exists(dir, marker),
	);
}

function hasRootMarker(markers: string[]): boolean {
	return markers.some(marker => ROOT_MARKERS.includes(marker));
}

function scoreMarkers(markers: string[]): number {
	let score = 0;

	for (const marker of markers) {
		if (marker === '.orbit' || marker === 'orbit') score += 80;
		else if (marker.startsWith('orbit.config')) score += 75;
		else if (marker === 'package.json') score += 50;
		else if (marker.startsWith('playwright.config')) score += 45;
		else if (marker.startsWith('cypress.config')) score += 40;
		else if (marker.startsWith('next.config')) score += 35;
		else if (marker.startsWith('vite.config')) score += 35;
		else if (marker === '.git') score += 25;
		else score += 5;
	}

	return Math.min(score, 100);
}

function detectPackageManager(
	markers: string[],
): ProjectDetectionResult['packageManager'] {
	if (markers.includes('pnpm-lock.yaml')) return 'pnpm';
	if (markers.includes('yarn.lock')) return 'yarn';
	if (markers.includes('bun.lockb')) return 'bun';
	if (markers.includes('package-lock.json')) return 'npm';
	if (markers.includes('package.json')) return 'npm';
	return undefined;
}

function detectFramework(markers: string[]): string | undefined {
	if (markers.some(marker => marker.startsWith('next.config')))
		return 'Next.js';
	if (markers.some(marker => marker.startsWith('vite.config'))) return 'Vite';
	return undefined;
}

function detectTestFramework(markers: string[]): string | undefined {
	if (markers.some(marker => marker.startsWith('playwright.config')))
		return 'Playwright';
	if (markers.some(marker => marker.startsWith('cypress.config')))
		return 'Cypress';
	return undefined;
}

export function detectProjectRoot(
	startDir = process.cwd(),
): ProjectDetectionResult {
	let currentDir = path.resolve(startDir);
	const homeDir = os.homedir();

	while (true) {
		const markers = getMarkers(currentDir);

		if (hasRootMarker(markers)) {
			const confidence = scoreMarkers(markers);

			return {
				isProject: confidence >= 40,
				root: confidence >= 40 ? currentDir : null,
				confidence,
				markers,
				packageManager: detectPackageManager(markers),
				framework: detectFramework(markers),
				testFramework: detectTestFramework(markers),
				hasOrbitFolder: markers.includes('.orbit') || markers.includes('orbit'),
			};
		}

		const parentDir = path.dirname(currentDir);

		if (
			parentDir === currentDir ||
			parentDir == homeDir ||
			currentDir === homeDir
		) {
			break;
		}

		currentDir = parentDir;
	}

	return {
		isProject: false,
		root: null,
		confidence: 0,
		markers: [],
		hasOrbitFolder: false,
	};
}

// An explicit path from the user (e.g. `/init <path>`) is trusted directly
// as the project root — unlike detectProjectRoot, this never walks up to a
// parent directory and never rejects the directory for scoring under the
// confidence threshold. That threshold exists to avoid false positives when
// *guessing* a root from an arbitrary cwd; it has no purpose once the user
// has named the directory themselves. This is the intended way to point
// Orbit at a directory its own heuristic can't reach (e.g. a Node frontend
// nested inside a polyglot monorepo whose actual root has no JS-specific
// marker at all).
export function detectProjectAtPath(
	explicitPath: string,
): ProjectDetectionResult {
	const resolved = path.resolve(explicitPath);

	if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
		return {
			isProject: false,
			root: null,
			confidence: 0,
			markers: [],
			hasOrbitFolder: false,
		};
	}

	const markers = getMarkers(resolved);

	return {
		isProject: true,
		root: resolved,
		confidence: scoreMarkers(markers),
		markers,
		packageManager: detectPackageManager(markers),
		framework: detectFramework(markers),
		testFramework: detectTestFramework(markers),
		hasOrbitFolder: markers.includes('.orbit') || markers.includes('orbit'),
	};
}

export function getProjectDisplayName(projectRoot: string) {
	const packageJsonPath = path.join(projectRoot, 'package.json');

	if (fs.existsSync(packageJsonPath)) {
		try {
			const packageJson = JSON.parse(
				fs.readFileSync(packageJsonPath, 'utf8'),
			) as {name?: string};

			if (packageJson.name) {
				return packageJson.name;
			}
		} catch {
			// Ignore invalid package.json and fall back to folder name
		}
	}

	return path.basename(projectRoot);
}
