import type {CommandContext} from '../../commands/context.js';
import type {ToolDefinition} from './types.js';

export type ListCommandsData = {
	content: string;
};

// Mirrors /help's own static text exactly, word for word — deliberately
// not derived from the `commands` array (whose descriptions are written
// for a human running them directly, not for summarizing the list). This
// can drift out of sync if /help's text changes without this being
// updated too; accepted for now to keep this simple. Read-only, never
// asks for approval.
export const listCommandsTool: ToolDefinition<
	Record<string, never>,
	ListCommandsData,
	{setMessages: CommandContext['setMessages']}
> = {
	name: 'list_commands',
	description:
		"List Orbit's available slash commands and what each does — the same text /help shows. Read-only, never asks for approval.",
	parameters: {type: 'object', properties: {}, required: []},
	async execute(_args, context) {
		const content = `
Available Orbit commands:
/help       Show available commands
/switch     Switch Orbit to work on a different project — also offers "Set Up Blind Project" when nothing is active yet
/init [path] Initialize Orbit — confirms the detected path first, or trusts an explicit one. Path is optional. If left empty, orbit will suggest one for you
/deinit     Delete the .orbit folder within the current project
/scan       Build index and context for the current project
/config     View and change project configuration — includes turning Blind mode on, which sets up (or switches to) a URL-only project with no local codebase involved
/test       Generate and run a Playwright test for a feature you describe
/coverage   Show routes and components that don't have a matching test
/projects   Show remembered projects
/memory     Show project memory (--overview / --decisions / --failures to filter, default all)
/clear      Clear the screen
/abort      Abort ongoing tasks that is currently running
/exit       Exit Orbit`;

		context.setMessages(previous => [...previous, {role: 'system', content}]);

		return {ok: true, data: {content}};
	},
};
