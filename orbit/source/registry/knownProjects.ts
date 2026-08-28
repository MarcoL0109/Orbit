import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type KnownProject = {
	name: string;
	// For a blind project, this is Orbit's own storage/workspace root, not a
	// detected codebase — there's nothing on disk to detect.
	path: string;
	framework?: string | null;
	packageManager?: string | null;
	testFramework?: string | null;
	description?: string | null;
	primaryFeatures?: string[];
	createdAt: string;
	lastOpenedAt: string;
	lastScannedAt?: string | null;
	openCount: number;
	// Blind mode: no local source, Orbit only ever explores this project
	// through a live browser against targetUrl. Absent/false for a normal,
	// filesystem-detected project.
	blind?: boolean;
	targetUrl?: string;
};

type ProjectsFile = {
	projects: KnownProject[];
};

function getGlobalProjectsPath() {
	return path.join(os.homedir(), '.orbit', 'projects.json');
}

export function readGlobalProjects(): ProjectsFile {
	const projectsPath = getGlobalProjectsPath();

	if (!fs.existsSync(projectsPath)) {
		return {projects: []};
	}

	const raw = fs.readFileSync(projectsPath, 'utf8');

	if (!raw.trim()) {
		return {projects: []};
	}

	try {
		return JSON.parse(raw) as ProjectsFile;
	} catch {
		return {projects: []};
	}
}

function writeGlobalProjects(data: ProjectsFile) {
	const projectsPath = getGlobalProjectsPath();

	fs.mkdirSync(path.dirname(projectsPath), {recursive: true});
	fs.writeFileSync(projectsPath, JSON.stringify(data, null, 2), 'utf8');
}

export function rememberProject(project: {
	name: string;
	path: string;
	framework?: string | null;
	packageManager?: string | null;
	testFramework?: string | null;
	description?: string | null;
	primaryFeatures?: string[];
	lastScannedAt?: string | null;
	blind?: boolean;
	targetUrl?: string;
}) {
	const now = new Date().toISOString();
	const data = readGlobalProjects();

	const existing = data.projects.find(item => item.path === project.path);

	if (existing) {
		existing.name = project.name;
		existing.framework = project.framework ?? existing.framework ?? null;
		existing.packageManager =
			project.packageManager ?? existing.packageManager ?? null;
		existing.testFramework =
			project.testFramework ?? existing.testFramework ?? null;
		existing.description = project.description ?? existing.description ?? null;
		existing.primaryFeatures =
			project.primaryFeatures ?? existing.primaryFeatures ?? [];
		existing.lastOpenedAt = now;
		existing.lastScannedAt =
			project.lastScannedAt ?? existing.lastScannedAt ?? null;
		existing.openCount = (existing.openCount ?? 0) + 1;
		existing.blind = project.blind ?? existing.blind;
		existing.targetUrl = project.targetUrl ?? existing.targetUrl;
	} else {
		data.projects.push({
			name: project.name,
			path: project.path,
			framework: project.framework ?? null,
			packageManager: project.packageManager ?? null,
			testFramework: project.testFramework ?? null,
			description: project.description ?? null,
			primaryFeatures: project.primaryFeatures ?? [],
			createdAt: now,
			lastOpenedAt: now,
			lastScannedAt: project.lastScannedAt ?? null,
			openCount: 1,
			blind: project.blind,
			targetUrl: project.targetUrl,
		});
	}

	writeGlobalProjects(data);
}

// Blind projects have no filesystem root to detect, so they can't be found
// the way a normal project is (walking cwd for markers) — the URL is the
// only handle the user has for "have I already set this one up." Exact
// match on the normalized string: no fuzzy/prefix matching, since two
// different paths on the same host are two different targets to Orbit.
export function findBlindProjectByUrl(url: string): KnownProject | undefined {
	const normalized = normalizeUrlForLookup(url);
	return readGlobalProjects().projects.find(
		project =>
			project.blind &&
			normalizeUrlForLookup(project.targetUrl ?? '') === normalized,
	);
}

function normalizeUrlForLookup(url: string): string {
	return url.trim().replace(/\/+$/, '').toLowerCase();
}

export function removeKnownProject(projectPath: string): boolean {
	const data = readGlobalProjects();
	const beforeCount = data.projects.length;
	const updatedProjects = data.projects.filter(
		project => project.path !== projectPath,
	);

	if (updatedProjects.length === beforeCount) {
		return false;
	}

	writeGlobalProjects({projects: updatedProjects});
	return true;
}

export function formatProjectsForTui(projectsFile: ProjectsFile) {
	const {projects} = projectsFile;
	if (projects.length === 0) {
		return `No projects remembered yet.
Run /init inside a project to add it to Orbit.`;
	}

	return `
Tracked projects:
${projects
	.map((project, index) => {
		return `${index + 1}. ${project.name}
Path: ${project.path}
Framework: ${project.framework ?? 'Unknown'}
Package manager: ${project.packageManager ?? 'Unknown'}
Test framework: ${project.testFramework ?? 'Unknown'}
Open count: ${project.openCount ?? 0}`;
	})
	.join('\n\n')}`;
}
