import type {CommandContext} from '../../commands/context.js';
import type {ToolDefinition} from './types.js';

export type ClearConversationData = {
	cleared: true;
};

// Mirrors /clear — wipes visible chat history, nothing else (no project
// state, no files). Low enough stakes that /clear itself never asks for
// confirmation, so this doesn't either. Only meaningful when the user
// explicitly asks to clear the screen/conversation; there's rarely a
// reason for the model to reach for this unprompted.
export const clearConversationTool: ToolDefinition<
	Record<string, never>,
	ClearConversationData,
	{setMessages: CommandContext['setMessages']}
> = {
	name: 'clear_conversation',
	description:
		'Clear the visible chat history, same as /clear. Only use this when the user explicitly asks to clear the screen or conversation.',
	parameters: {type: 'object', properties: {}, required: []},
	async execute(_args, context) {
		context.setMessages([]);
		return {ok: true, data: {cleared: true}};
	},
};
