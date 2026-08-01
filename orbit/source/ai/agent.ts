import type { Response, ResponseCreateParamsNonStreaming, ResponseFunctionToolCall, ResponseInputItem } from 'openai/resources/responses/responses';
import { createOpenAIClient } from './client.js';
import { toolRegistry, findTool, toApiToolSchema, type ToolContext, type ToolResult } from './tools/index.js';
import type { ReportResultArgs } from './tools/reportResult.js';
import type { RunTestResult } from './tools/runTest.js';

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

function buildSystemPrompt(context: ToolContext): string {
    return `You are Orbit, an AI QA agent for E2E testing.

Your job: given a description of a feature to test, write a Playwright test for it using the write_test_file tool, then run it using the run_test tool.

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
    const steps: AgentStep[] = [];

    let previousResponseId: string | undefined;
    let nextInput: string | ResponseInputItem[] = prompt;

    for (let stepCount = 0; stepCount < maxSteps; stepCount++) {
        if (context.signal.aborted) {
            return {status: 'aborted', summary: 'Aborted by user', steps};
        }

        const response = await client.responses.create({
            model: 'gpt-5.2',
            instructions: buildSystemPrompt(context),
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
