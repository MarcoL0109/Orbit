import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type KnownProject = {
  name: string;
  path: string;
  framework?: string;
  packageManager?: string;
  testFramework?: string;
  lastOpenedAt?: string;
  openCount?: number;
};

type ProjectsFile = {
  projects: KnownProject[];
};


export function getGlobalProjectsPath() {
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
    return JSON.parse(raw) as ProjectsFile;
}


export function formatProjectsForTui(projectsFile: ProjectsFile) {
    const {projects} = projectsFile;
    if (projects.length === 0) {
        return `No projects remembered yet.
Run /init inside a project to add it to Orbit.`;
    }
    return `Tracked projects:
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