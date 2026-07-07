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

export function getOrbitHomeDir() {
  return path.join(os.homedir(), '.orbit');
}

export function getProjectsJsonPath() {
  return path.join(getOrbitHomeDir(), 'projects.json');
}

export function ensureProjectsJson() {
  const orbitHome = getOrbitHomeDir();
  const projectsPath = getProjectsJsonPath();

  fs.mkdirSync(orbitHome, {recursive: true});

  if (!fs.existsSync(projectsPath)) {
    fs.writeFileSync(
      projectsPath,
      JSON.stringify({projects: []}, null, 2),
      'utf8',
    );
  }

  return projectsPath;
}

export function readProjectsJson(): ProjectsFile {
  const projectsPath = ensureProjectsJson();
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

export function writeProjectsJson(data: ProjectsFile) {
  const projectsPath = ensureProjectsJson();

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
  const data = readProjectsJson();

  const existing = data.projects.find((item) => item.path === project.path);

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

  writeProjectsJson(data);
}