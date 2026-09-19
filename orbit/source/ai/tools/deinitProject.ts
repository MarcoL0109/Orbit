import {
	getProjectPath,
	deinitLocalContext,
	deinitGlobalContext,
} from '../../init/deinit.js';
import type {CommandContext} from '../../commands/context.js';
import type {ToolDefinition} from './types.js';

export type DeinitProjectData = {
	deleted: true;
};

type DeinitProjectContext = CommandContext & {
	project: CommandContext['project'];
};

// Mirrors /deinit — deletes the current project's .orbit folder (all its
// sessions, traces, memory, config) and removes it from Orbit's global
// project registry. Irreversible and the most consequential of the
// wrapped commands, so this asks for approval every time, no exceptions.
// After this runs, the active project is gone — same as /deinit typed
// directly, a conversation continuing past this point has no project left
// to operate on until the user switches or re-initializes one.
export const deinitProjectTool: ToolDefinition<
	Record<string, never>,
	DeinitProjectData,
	DeinitProjectContext
> = {
	name: 'deinit_project',
	description:
		"Delete the current project's .orbit context entirely (all sessions, traces, memory, config), same as /deinit. Irreversible — every call asks the user for approval first, with no exceptions.",
	parameters: {type: 'object', properties: {}, required: []},
	async execute(_args, context) {
		const projectPath = getProjectPath(context.project);
		if (!projectPath.ok) {
			return {ok: false, error: 'No project selected.'};
		}

		const approved = await context.requestApproval(
			`Delete Orbit's .orbit context for ${projectPath.route}? This removes all sessions, traces, memory, and config for this project and cannot be undone.`,
		);
		if (!approved) {
			return {ok: false, error: 'User declined to deinit this project'};
		}

		const path = projectPath.route;
		deinitLocalContext(path);
		context.setMessages(previous => [
			...previous,
			{
				role: 'system',
				content: `Orbit context of ${path} deleted successfully`,
				color: 'green',
			},
		]);

		if (context.project?.root) {
			const globalResult = deinitGlobalContext(context.project.root);
			if (globalResult.ok) {
				context.setMessages(previous => [
					...previous,
					{
						role: 'system',
						content: 'Removed project from global orbit memory',
						color: 'green',
					},
				]);
			}
		}

		context.setProject(null);

		return {ok: true, data: {deleted: true}};
	},
};
