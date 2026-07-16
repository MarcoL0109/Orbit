import fs from 'node:fs';
import type { KnownProject } from "./initMark.js";
import type { ProjectInfo } from '../commands/context.js';
import { getProjectsJsonPath } from './initMark.js';


export type DeinitResponse = {
    ok: boolean,
    route: string,
    context: string,
};


export function deinitContext(name: string, project: ProjectInfo): DeinitResponse {
    if (name !== '') {
        const projectPath = getProjectsJsonPath();
        const raw = fs.readFileSync(projectPath, 'utf8');
        const jsonContent = JSON.parse(raw) as KnownProject[];

        const targetedProject = jsonContent.filter((project) => project.name === name);
        if (!targetedProject) {
            return {ok: false, route: '', context: `Project named ${name} not found`};
        }
    }
    return {ok: true, route: project.root || '', context: `Project named ${name} found`};
}