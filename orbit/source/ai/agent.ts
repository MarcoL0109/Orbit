import type { Response, ResponseCreateParamsNonStreaming, ResponseFunctionToolCall, ResponseInputItem } from 'openai/resources/responses/responses';
import { createOpenAIClient } from './client.js';
import { toolRegistry, findTool, toApiToolSchema, type ToolContext, type ToolResult } from './tools/index.js';
import type { ReportResultArgs } from './tools/reportResult.js';
import type { RunTestResult } from './tools/runTest.js';
import { readProjectMap, type ProjectMap } from '../projects/scan.js';

// Only what the loop actually calls — accepted as a dependency rather than
// constructed internally, so the loop is testable without a live API key.
export type ResponsesClient = {
    responses: {
        create: (params: ResponseCreateParamsNonStreaming, options?: {signal?: AbortSignal}) => Promise<Response>;
    };
};

export type AgentStep =
    | {type: 'tool_call'; name: string; args: unknown}
    | {type: 'tool_result'; name: string; result: ToolResult};

export type AgentRunResult = {
    status: 'passed' | 'failed' | 'gave_up' | 'aborted';
    summary: string;
    steps: AgentStep[];
};

// Fired as each tool call starts, so the UI can show something more useful
// than a static "thinking" spinner while the loop runs.
export type AgentProgressEvent = {name: string};

const ACTIVITY_LABEL: Record<string, string> = {
    read_file: 'Reading project files...',
    write_test_file: 'Writing the test file...',
    run_test: 'Running the test...',
    report_result: 'Wrapping up...',
};

export function describeAgentActivity(event: AgentProgressEvent): string {
    return ACTIVITY_LABEL[event.name] ?? `Running ${event.name}...`;
}

export type RunTestingAgentOptions = {
    maxSteps?: number;
    client?: ResponsesClient;
    onProgress?: (event: AgentProgressEvent) => void;
};

const MAX_LISTED_ITEMS = 50;

function formatList(items: string[]): string {
    if (items.length === 0) return 'None detected';
    const shown = items.slice(0, MAX_LISTED_ITEMS);
    const remainder = items.length - shown.length;
    return shown.join('\n') + (remainder > 0 ? `\n...and ${remainder} more` : '');
}

// Reuses whatever /scan already computed instead of leaving the model to
// guess file paths blind — read_file still exists for the actual deep dive
// once it knows which file is relevant.
function summarizeProjectMap(projectMap: ProjectMap | null): string {
    if (!projectMap) {
        return 'No project index available yet (run /scan first for a list of known routes and components) — you will need to find files by informed guesswork.';
    }

    const routes = projectMap.routes.map((route) => `- ${route.route} -> ${route.file}`);
    const components = projectMap.components.map((component) => `- ${component.name} -> ${component.file}`);
    const tests = projectMap.tests.map((test) => `- ${test.file}`);

    return `Known project structure (from the last /scan, ${projectMap.generatedAt}):

Routes:
${formatList(routes)}

Components:
${formatList(components)}

Existing tests:
${formatList(tests)}`;
}

function buildSystemPrompt(context: ToolContext, projectMap: ProjectMap | null): string {
    return `You are Orbit, an AI QA agent for E2E testing.

Your job: given a description of a feature to test, write a Playwright test for it using the write_test_file tool, then run it using the run_test tool.

${summarizeProjectMap(projectMap)}

Use this index to find the right file to read before writing selectors — prefer it over guessing paths. If the feature you're asked to test isn't listed, use read_file to explore starting from a route or component that seems related.

If a run fails because of a broken selector or similar test-side issue, you may patch the test and run it again — you have a budget of ${context.orbitConfig.maxRepairAttempts} repair attempts for this task. If a run fails because of an actual application bug (not a problem with the test itself), do not keep patching it — report the failure instead.

Rules:
- Prefer Playwright and role-based selectors (getByRole, getByLabel, getByText).
- Use read_file to look at the actual markup of a component or route before writing selectors against it — do not guess.
- write_test_file only accepts paths inside the project's configured test directory (${context.orbitConfig.testDir}).
- Do not invent project features you have not verified by reading a file.
- Do not attempt to read or use any variables in a .env file.
- Call report_result exactly once, when you are done, with a final status. Do not stop without calling it.`;
}

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

export async function runTestingAgent(
    prompt: string,
    context: ToolContext,
    options: RunTestingAgentOptions = {},
): Promise<AgentRunResult> {
    const maxSteps = options.maxSteps ?? 20;
    const client = options.client ?? createOpenAIClient();
    const projectMap = readProjectMap(context.projectRoot);
    const steps: AgentStep[] = [];

    let previousResponseId: string | undefined;
    let nextInput: string | ResponseInputItem[] = prompt;

    for (let stepCount = 0; stepCount < maxSteps; stepCount++) {
        if (context.signal.aborted) {
            return {status: 'aborted', summary: 'Aborted by user', steps};
        }

        const response = await client.responses.create({
            model: 'gpt-5.2',
            instructions: buildSystemPrompt(context, projectMap),
            input: nextInput,
            previous_response_id: previousResponseId,
            tools: toolRegistry.map(toApiToolSchema),
        }, {signal: context.signal});

        previousResponseId = response.id;

        const functionCalls = extractFunctionCalls(response);

        if (functionCalls.length === 0) {
            return {
                status: 'gave_up',
                summary: response.output_text || 'Agent stopped without reporting a result',
                steps,
            };
        }

        const outputItems: ResponseInputItem[] = [];
        let finalResult: AgentRunResult | null = null;

        for (const call of functionCalls) {
            const args = parseToolArguments(call.arguments);
            steps.push({type: 'tool_call', name: call.name, args});
            options.onProgress?.({name: call.name});

            const tool = findTool(call.name);
            const result: ToolResult = tool
                ? await tool.execute(args, context)
                : {ok: false, error: `Unknown tool: ${call.name}`};

            steps.push({type: 'tool_result', name: call.name, result});

            outputItems.push({
                type: 'function_call_output',
                call_id: call.call_id,
                output: JSON.stringify(result),
            });

            if (call.name === 'report_result' && result.ok) {
                const data = result.data as ReportResultArgs;
                finalResult = {status: data.status, summary: data.summary, steps};
            }
        }

        if (finalResult) {
            return finalResult;
        }

        nextInput = outputItems;
    }

    return {
        status: 'gave_up',
        summary: `Stopped after ${maxSteps} steps without a final result`,
        steps,
    };
}

const STATUS_LABEL: Record<AgentRunResult['status'], string> = {
    passed: 'Test passed',
    failed: 'Test failed',
    gave_up: 'Gave up',
    aborted: 'Aborted',
};

export function formatAgentRunResult(result: AgentRunResult): string {
    const filesWritten = new Set<string>();
    let runCount = 0;
    let lastRunResult: RunTestResult | null = null;

    for (const step of result.steps) {
        if (step.type === 'tool_call' && step.name === 'write_test_file') {
            const args = step.args as {relativePath?: string};
            if (args.relativePath) filesWritten.add(args.relativePath);
        }

        if (step.type === 'tool_result' && step.name === 'run_test' && step.result.ok) {
            runCount++;
            lastRunResult = step.result.data as RunTestResult;
        }
    }

    const filesText = filesWritten.size > 0
        ? [...filesWritten].map((file) => `- ${file}`).join('\n')
        : 'None';

    const testsText = lastRunResult
        ? `${lastRunResult.passedCount}/${lastRunResult.totalTests} passed (${lastRunResult.durationMs}ms)`
        : 'Not run';

    const attemptsText = runCount > 1 ? `\nRun attempts: ${runCount}` : '';

    const failuresText = lastRunResult && lastRunResult.failures.length > 0
        ? `\n\nFailures:\n${lastRunResult.failures
            .map((failure) => `- ${failure.testTitle}: ${failure.errorMessage}`)
            .join('\n')}`
        : '';

    return `${STATUS_LABEL[result.status]}: ${result.summary}

Files written:
${filesText}

Tests: ${testsText}${attemptsText}${failuresText}`;
}
