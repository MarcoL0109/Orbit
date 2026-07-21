import fs from 'node:fs';
import type { ProjectInfo } from '../commands/context.js';


export type DeinitResponse = {
    ok: boolean;
    route: string;
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

export function deinitContext(path: string) {
    fs.rmSync(`${path}/.orbit`, { recursive: true, force: true });
}