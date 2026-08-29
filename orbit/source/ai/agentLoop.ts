import type {
	Response,
	ResponseFunctionToolCall,
	ResponseInputItem,
} from 'openai/resources/responses/responses';
import type {ResponsesClient} from './client.js';
import {toApiToolSchema} from './tools/index.js';
import type {ToolDefinition, ToolResult} from './tools/types.js';

export type AgentStep =
	| {type: 'tool_call'; name: string; args: unknown}
	| {type: 'tool_result'; name: string; result: ToolResult};

export type AgentProgressEvent = {name: string};

function parseToolArguments(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

function extractFunctionCalls(response: Response): ResponseFunctionToolCall[] {
	return response.output.filter(
		(item): item is ResponseFunctionToolCall => item.type === 'function_call',
	);
}

export type DispatchedCall = {name: string; args: unknown; result: ToolResult};

export type AgentTurnResult = {
	responseId: string;
	outputText: string;
	// Empty means the model made no tool calls this turn — every agent
	// built on this loop treats that as "stopped without finishing."
	functionCalls: ResponseFunctionToolCall[];
	dispatchedCalls: DispatchedCall[];
	// Feed as the next turn's `input` when continuing.
	outputItems: ResponseInputItem[];
};

// One round trip: call the model, then execute every tool call it made
// (a turn can contain more than one). This is the only part that's
// genuinely identical across agents built on it — deciding when a run is
// "done" (which tool counts as terminal, how to shape a final result, what
// "gave up" looks like) is each agent's own concern, kept in its own thin
// wrapper loop rather than folded in here. See runTestingAgent (agent.ts)
// and the environment setup agent for the two current callers.
export async function runAgentTurn<Context>(parameters: {
	client: ResponsesClient;
	model: string;
	instructions: string;
	input: string | ResponseInputItem[];
	previousResponseId: string | undefined;
	toolRegistry: Array<ToolDefinition<any, any, Context>>;
	context: Context;
	signal: AbortSignal;
	steps: AgentStep[];
	onProgress?: (event: AgentProgressEvent) => void;
	// Called right before a tool executes / right after it resolves — for
	// an agent's own side-channel tracking (e.g. "has browser_action been
	// used yet this run"), not part of the loop's own bookkeeping.
	onToolDispatched?: (name: string, args: unknown) => void;
	onToolResult?: (name: string, args: unknown, result: ToolResult) => void;
	// Every model call in this codebase goes through this one function
	// (agent.ts, askAgent.ts, environmentSetupAgent.ts all call it), which
	// is what makes this the single place usage can be captured for all of
	// them at once rather than duplicated at each caller.
	onUsage?: (usage: {inputTokens: number; outputTokens: number}) => void;
}): Promise<AgentTurnResult> {
	const response = await parameters.client.responses.create(
		{
			model: parameters.model,
			instructions: parameters.instructions,
			input: parameters.input,
			previous_response_id: parameters.previousResponseId,
			tools: parameters.toolRegistry.map(toApiToolSchema),
		},
		{signal: parameters.signal},
	);

	if (response.usage) {
		parameters.onUsage?.({
			inputTokens: response.usage.input_tokens,
			outputTokens: response.usage.output_tokens,
		});
	}

	const functionCalls = extractFunctionCalls(response);
	const dispatchedCalls: DispatchedCall[] = [];
	const outputItems: ResponseInputItem[] = [];

	for (const call of functionCalls) {
		const args = parseToolArguments(call.arguments);
		parameters.steps.push({type: 'tool_call', name: call.name, args});
		parameters.onProgress?.({name: call.name});
		parameters.onToolDispatched?.(call.name, args);

		const tool = parameters.toolRegistry.find(
			candidate => candidate.name === call.name,
		);
		const result: ToolResult = tool
			? await tool.execute(args, parameters.context)
			: {ok: false, error: `Unknown tool: ${call.name}`};

		parameters.steps.push({type: 'tool_result', name: call.name, result});
		parameters.onToolResult?.(call.name, args, result);

		dispatchedCalls.push({name: call.name, args, result});
		outputItems.push({
			type: 'function_call_output',
			call_id: call.call_id,
			output: JSON.stringify(result),
		});
	}

	return {
		responseId: response.id,
		outputText: response.output_text,
		functionCalls,
		dispatchedCalls,
		outputItems,
	};
}
