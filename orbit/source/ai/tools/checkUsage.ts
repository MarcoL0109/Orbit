import {
	readGlobalUsage,
	estimateCostUsd,
	totalTokens,
} from '../../registry/usage.js';
import type {CommandContext} from '../../commands/context.js';
import type {ToolDefinition} from './types.js';

export type CheckUsageData = {
	content: string;
};

// Global, not project-scoped — same reasoning as usage.ts itself. Read-only
// counterpart to app.tsx's own USAGE panel, so a bare-prompt "what's my API
// usage" question has something real to answer from instead of the model
// having nothing to call and either declining or guessing. Never asks for
// approval — reading a local stats file has no side effects.
export const checkUsageTool: ToolDefinition<
	Record<string, never>,
	CheckUsageData,
	{setMessages: CommandContext['setMessages']}
> = {
	name: 'check_usage',
	description:
		"Show Orbit's tracked OpenAI token usage and estimated cost across all projects, broken down by model — the same numbers the USAGE panel shows. Read-only, never asks for approval.",
	parameters: {type: 'object', properties: {}, required: []},
	async execute(_args, context) {
		const usage = readGlobalUsage();
		const tokens = totalTokens(usage);
		const cost = estimateCostUsd(usage);

		const lines = [
			usage.since
				? `Tracking since ${new Date(usage.since).toLocaleDateString()}.`
				: 'No usage tracked yet.',
			`Total: ${tokens.inputTokens.toLocaleString()} input / ${tokens.outputTokens.toLocaleString()} output tokens, ~$${cost.totalUsd.toFixed(
				2,
			)}.`,
			...Object.entries(usage.byModel).map(
				([model, entry]) =>
					`  ${model}: ${entry.inputTokens.toLocaleString()} in / ${entry.outputTokens.toLocaleString()} out`,
			),
			...(cost.unpricedModels.length > 0
				? [
						`Note: usage for ${cost.unpricedModels.join(
							', ',
						)} has no known rate and isn't included in the cost estimate.`,
				  ]
				: []),
		];
		const content = lines.join('\n');

		context.setMessages(previous => [...previous, {role: 'agent', content}]);

		return {ok: true, data: {content}};
	},
};
