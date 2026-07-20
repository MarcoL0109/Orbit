import fs from 'node:fs';
import type { KnownProject } from "./initMark.js";
import type { ProjectInfo } from '../commands/context.js';
import { getProjectsJsonPath } from './initMark.js';


export type DeinitResponse = {
    ok: boolean;
    route: string;
    context: string;
};

export function getProjectPath(name: string, project: ProjectInfo | null): DeinitResponse {
    const trimmedName = name.trim();
    if (trimmedName !== '') {
        const projectsPath = getProjectsJsonPath();

        if (!fs.existsSync(projectsPath)) {
            return {
                ok: false,
                route: '',
                context: 'Global projects.json was not found.',
            };
        }

        try {
            const raw = fs.readFileSync(projectsPath, 'utf8');

            const jsonContent = JSON.parse(raw) as {
                projects: KnownProject[];
            };

            const targetedProject = jsonContent.projects.find(
                (project) => project.name === trimmedName,
            );

            if (!targetedProject) {
                return {
                    ok: false,
                    route: '',
                    context: `Project named "${trimmedName}" was not found.`,
                };
            }

            return {
                ok: true,
                route: targetedProject.path,
                context: `Project named "${trimmedName}" found.`,
            };
        } catch (error) {
            return {
                ok: false,
                route: '',
                context: `Failed to read global projects.json: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            };
        }
    }

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