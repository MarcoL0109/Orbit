import {
	readGlobalUsage,
	resetGlobalUsage,
	estimateCostUsd,
	totalTokens,
} from '../../registry/usage.js';
import type {CommandContext} from '../../commands/context.js';
import type {ToolDefinition} from './types.js';

export type ResetUsageData = {
	reset: true;
};

// Mirrors /usage's own only real action (reset — /usage has no separate
// "just view" mode, see check_usage for that). Irreversible, so this asks
// for approval every time, same as /usage's own confirmation prompt.
export const resetUsageTool: ToolDefinition<
	Record<string, never>,
	ResetUsageData,
	{setMessages: CommandContext['setMessages']; requestApproval: CommandContext['requestApproval']}
> = {
	name: 'reset_usage',
	description:
		"Reset Orbit's tracked OpenAI token usage back to zero, same as /usage. This cannot be undone — every call asks the user for approval first, with no exceptions.",
	parameters: {type: 'object', properties: {}, required: []},
	async execute(_args, context) {
		const current = readGlobalUsage();
		const tokens = totalTokens(current);
		const sinceText = current.since
			? `since ${new Date(current.since).toLocaleDateString()}`
			: 'with no prior recording';

		const approved = await context.requestApproval(
			`Reset tracked usage (${tokens.inputTokens.toLocaleString()} input / ${tokens.outputTokens.toLocaleString()} output tokens, ~$${estimateCostUsd(
				current,
			).totalUsd.toFixed(2)}, ${sinceText}) back to zero? This cannot be undone.`,
		);
		if (!approved) {
			return {ok: false, error: 'User declined to reset usage'};
		}

		resetGlobalUsage();
		context.setMessages(previous => [
			...previous,
			{role: 'system', content: 'Usage stats reset.', color: 'green'},
		]);

		return {ok: true, data: {reset: true}};
	},
};
