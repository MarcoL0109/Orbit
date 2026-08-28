import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IGNORE_DIRS = new Set([
	'node_modules',
	'.git',
	'.orbit',
	// A blind-mode project's own Orbit folder (see orbitDir.ts) — never
	// walked as app source, same reason '.orbit' is skipped above.
	'orbit',
	'dist',
	'build',
	'coverage',
	'.next',
	'.turbo',
	'playwright-report',
	'test-results',
	'.cache',
	'.output',
	'.vercel',
	'.svelte-kit',
	'.parcel-cache',
	'.pnpm-store',
	'venv',
	'.venv',
	'__pycache__',
	'tmp',
]);

const SOURCE_EXTENSIONS = new Set([
	'.ts',
	'.tsx',
	'.js',
	'.jsx',
	'.mts',
	'.cts',
	'.mjs',
	'.cjs',
]);

const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);
const IMPORTANT_FILES = new Set([
	'package.json',
	'tsconfig.json',
	'vite.config.ts',
	'vite.config.js',
	'vite.config.mts',
	'next.config.ts',
	'next.config.js',
	'next.config.mjs',
	'playwright.config.ts',
	'playwright.config.js',
	'cypress.config.ts',
	'cypress.config.js',
	'vitest.config.ts',
	'vitest.config.js',
	'README.md',
]);

export function resolveUserPath(input: string, baseDir = process.cwd()) {
	let rawPath = input.trim();

	if (!rawPath) {
		throw new Error('Path is empty');
	}

	// Remove surrounding quotes: "~/Project" or '~/Project'
	rawPath = rawPath.replace(/^["']|["']$/g, '');

	// Expand ~ to home directory
	if (rawPath === '~') {
		rawPath = os.homedir();
	} else if (rawPath.startsWith('~/')) {
		rawPath = path.join(os.homedir(), rawPath.slice(2));
	}

	// Convert relative path to absolute path
	const absolutePath = path.isAbsolute(rawPath)
		? rawPath
		: path.resolve(baseDir, rawPath);

	return absolutePath;
}

export function validateProjectPath(input: string, baseDir = process.cwd()) {
	const resolvedPath = resolveUserPath(input, baseDir);

	if (!fs.existsSync(resolvedPath)) {
		return {
			ok: false as const,
			path: resolvedPath,
			error: 'Path does not exist',
		};
	}

	const stat = fs.statSync(resolvedPath);

	if (!stat.isDirectory()) {
		return {
			ok: false as const,
			path: resolvedPath,
			error: 'Path is not a directory',
		};
	}

	return {
		ok: true as const,
		path: resolvedPath,
	};
}

// Only supports plain directory/file names (no globs, no negation, no
// nested paths) — full gitignore semantics are out of scope for this
// lightweight scanner.
function readGitignoreNames(projectRoot: string): Set<string> {
	const gitignorePath = path.join(projectRoot, '.gitignore');
	const names = new Set<string>();

	if (!fs.existsSync(gitignorePath)) {
		return names;
	}

	let lines: string[] = [];

	try {
		lines = fs.readFileSync(gitignorePath, 'utf8').split('\n');
	} catch {
		return names;
	}

	for (const rawLine of lines) {
		const line = rawLine.trim();

		if (
			!line ||
			line.startsWith('#') ||
			line.startsWith('!') ||
			line.includes('*') ||
			line.includes('/')
		) {
			continue;
		}

		names.add(line);
	}

	return names;
}

export function walkProjectFiles(projectRoot: string) {
	const results: string[] = [];
	const ignoredNames = new Set([
		...IGNORE_DIRS,
		...readGitignoreNames(projectRoot),
	]);

	function walk(currentDir: string) {
		const entries = fs.readdirSync(currentDir, {
			withFileTypes: true,
		});

		for (const entry of entries) {
			if (ignoredNames.has(entry.name)) {
				continue;
			}

			const absolutePath = path.join(currentDir, entry.name);
			const relativePath = path.relative(projectRoot, absolutePath);
			const normalizedPath = relativePath.split(path.sep).join('/');

			if (entry.isDirectory()) {
				walk(absolutePath);
				continue;
			}

			if (!entry.isFile()) {
				continue;
			}

			const ext = path.extname(entry.name);
			const base = path.basename(entry.name);

			if (
				SOURCE_EXTENSIONS.has(ext) ||
				MARKDOWN_EXTENSIONS.has(ext) ||
				IMPORTANT_FILES.has(base)
			) {
				results.push(normalizedPath);
			}
		}
	}

	walk(projectRoot);

	return results.sort();
}
