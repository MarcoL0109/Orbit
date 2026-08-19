import type {ResponseInputItem} from 'openai/resources/responses/responses';
import {graphifyGraphExists} from '../projects/graphifyGraph.js';
import {readProjectMap, type ProjectMap} from '../projects/scan.js';
import {readProjectMemory, type ProjectMemory} from '../init/memory.js';
import type {CommandContext} from '../commands/context.js';
import {createOpenAIClient, type ResponsesClient} from './client.js';
import {
	runAgentTurn,
	type AgentStep,
	type AgentProgressEvent,
	type AgentTurnResult,
} from './agentLoop.js';
import {summarizeProjectMap, summarizeMemory} from './agent.js';
import {readFileTool} from './tools/readFile.js';
import {explainSymbolTool} from './tools/explainSymbol.js';
import {checkMemoryTool} from './tools/checkMemory.js';
import {checkCoverageTool} from './tools/checkCoverage.js';
import {refreshProjectScanTool} from './tools/refreshProjectScan.js';
import {runTestCommandTool} from './tools/runTestCommandTool.js';
import type {ToolDefinition} from './tools/types.js';

// Extends the full CommandContext (not a narrower subset) because
// run_test_command needs essentially everything a real /test invocation
// does — requestInput, requestOutcomeConfirmation, isEnvironmentReady/
// markEnvironmentReady, setAgentActivity, setMessages, project — not just
// the handful of fields the other, simpler tools use. No orbitConfig field
// of its own to add: it's reachable through context.project instead, same
// as every real command handler already gets it.
export type AskAgentContext = CommandContext & {
	projectRoot: string;
	signal: AbortSignal;
};

export type AskAgentResult = {
	status: 'answered' | 'gave_up' | 'aborted';
	answer: string;
	steps: AgentStep[];
};

export type RunAskAgentOptions = {
	maxSteps?: number;
	client?: ResponsesClient;
	onProgress?: (event: AgentProgressEvent) => void;
};

const baseToolRegistry: Array<ToolDefinition<any, any, AskAgentContext>> = [
	readFileTool,
	checkMemoryTool,
	checkCoverageTool,
	refreshProjectScanTool,
	runTestCommandTool,
];

function buildSystemPrompt(
	projectMap: ProjectMap | null,
	memory: ProjectMemory,
	hasExplainSymbol: boolean,
): string {
	return `You are Orbit, an AI QA agent for E2E testing. Right now you are in ASK mode, not test mode: the user typed a plain question rather than a /test request, so your only job is to answer it using what you can find out about this project.

Beyond read_file/explain_symbol, you also have Orbit's own commands as tools: check_memory, check_coverage, refresh_project_scan, and run_test_command (the real /test — writes a real test file and runs it against the live app). The first three are read-only and never ask for approval, same as if the user ran them directly. run_test_command is the one exception: because it has real effects on the live app and the project's own test files, every single call to it asks the user for approval first, with no way around it — use it only when the question genuinely can't be answered any other way (e.g. the user is explicitly asking you to verify or test something live), not as a first resort. Each of these commands already shows its own normal output in the chat as it runs, exactly as if the user had typed it themselves — you don't need to repeat that output back, just build your own answer on top of what it told you.

${summarizeProjectMap(projectMap, [])}

Project memory (read this before answering — it documents conventions and past findings you should already know about):

${summarizeMemory(memory)}

Rules:
- Answer directly and concisely, in plain text. No special tool call is needed to finish — once you have enough to answer, just reply.
- ${
		hasExplainSymbol
			? 'A code knowledge graph is available (explain_symbol). Call it before read_file on any route, component, or function you have not already looked at this turn — it is far cheaper and shows what something connects to (callers, imports, callees) without needing the full source. Fall back to read_file once you actually need to see real code.'
			: 'Use read_file to explore starting from whatever route, component, or file seems most relevant to the question.'
	}
- Cite what you're basing the answer on (a file path, a symbol/line, or which command you ran) so the user can verify it themselves.
- Do not guess or invent behavior you have not actually verified by reading it or running a command. If you cannot find something in the project, say so plainly rather than making something up.`;
}

export async function runAskAgent(
	prompt: string,
	context: AskAgentContext,
	options: RunAskAgentOptions = {},
): Promise<AskAgentResult> {
	const maxSteps = options.maxSteps ?? 15;
	const client = options.client ?? createOpenAIClient();
	const steps: AgentStep[] = [];

	const hasExplainSymbol = graphifyGraphExists(context.projectRoot);
	const activeToolRegistry = hasExplainSymbol
		? [...baseToolRegistry, explainSymbolTool]
		: baseToolRegistry;

	// Read once, not per-turn — unlike the testing agent, nothing here
	// writes to the project mid-run, so the map/memory can't go stale
	// between turns of the same ask.
	const projectMap = readProjectMap(context.projectRoot);
	const memory = readProjectMemory(context.projectRoot);
	const instructions = buildSystemPrompt(projectMap, memory, hasExplainSymbol);

	let previousResponseId: string | undefined;
	let nextInput: string | ResponseInputItem[] = prompt;

	for (let stepCount = 0; stepCount < maxSteps; stepCount++) {
		if (context.signal.aborted) {
			return {status: 'aborted', answer: 'Aborted by user', steps};
		}

		const turn: AgentTurnResult = await runAgentTurn<AskAgentContext>({
			client,
			model: 'gpt-5.2',
			instructions,
			input: nextInput,
			previousResponseId,
			toolRegistry: activeToolRegistry,
			context,
			signal: context.signal,
			steps,
			onProgress: options.onProgress,
		});

		previousResponseId = turn.responseId;

		if (turn.functionCalls.length === 0) {
			return {
				status: 'answered',
				answer: turn.outputText || "I don't have an answer for that.",
				steps,
			};
		}

		nextInput = turn.outputItems;
	}

	return {
		status: 'gave_up',
		answer: `Stopped after ${maxSteps} steps without a final answer.`,
		steps,
	};
}
