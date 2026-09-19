import {readGlobalProjects, formatProjectsForTui} from '../../registry/knownProjects.js';
import type {CommandContext} from '../../commands/context.js';
import type {ToolDefinition} from './types.js';

export type ListProjectsData = {
	content: string;
};

// Read-only counterpart to /projects, reusing its exact formatting so the
// two never drift. Never asks for approval.
export const listProjectsTool: ToolDefinition<
	Record<string, never>,
	ListProjectsData,
	{setMessages: CommandContext['setMessages']}
> = {
	name: 'list_projects',
	description:
		"Show every project Orbit remembers across the whole machine, not just this one — the same list /projects shows. Read-only, never asks for approval.",
	parameters: {type: 'object', properties: {}, required: []},
	async execute(_args, context) {
		const projectsFile = readGlobalProjects();
		const content = formatProjectsForTui(projectsFile);

		context.setMessages(previous => [...previous, {role: 'system', content}]);

		return {ok: true, data: {content}};
	},
};
