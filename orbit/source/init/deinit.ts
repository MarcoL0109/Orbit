import fs from 'node:fs';
import type { ProjectInfo } from '../commands/context.js';
import { removeKnownProject } from '../registry/knownProjects.js';



export type DeinitResponse = {
    ok: boolean;
    route: string;
    context: string;
};

export type DeinitGlobalContextResponse = {
  ok: boolean;
  context: string;
};

export function getProjectPath(project: ProjectInfo | null): DeinitResponse {
    if (!project?.root) {
        return {
            ok: false,
            route: '',
            context: 'No current project selected.',
        };
    }
    return {
        ok: true,
        route: project.root,
        context: 'Using current selected project.',
    };
}

export function deinitLocalContext(path: string) {
    fs.rmSync(`${path}/.orbit`, { recursive: true, force: true });
}


export function deinitGlobalContext(projectRoot: string): DeinitGlobalContextResponse {
    const removed = removeKnownProject(projectRoot);

    if (!removed) {
        return {
            ok: false,
            context: `Project was not found in global Orbit memory: ${projectRoot}`,
        };
    }

    return {
        ok: true,
        context: `Removed project from global Orbit memory: ${projectRoot}`,
    };
}