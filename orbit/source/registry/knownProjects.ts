import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type KnownProject = {
	name: string;
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
		});
	}

	writeGlobalProjects(data);
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
