import type { Response, ResponseCreateParamsNonStreaming, ResponseFunctionToolCall, ResponseInputItem } from 'openai/resources/responses/responses';
import { createOpenAIClient } from './client.js';
import { toolRegistry, findTool, toApiToolSchema, type ToolContext, type ToolResult } from './tools/index.js';
import type { ReportResultArgs, FeatureResult } from './tools/reportResult.js';
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
    results: FeatureResult[];
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

Your job: given a description of one or more features to test, write a Playwright test for each feature using the write_test_file tool, then run it using the run_test tool.

If the prompt describes multiple distinct features, write a SEPARATE test file for each one (e.g. login.spec.ts, checkout.spec.ts) — do not combine multiple features into a single file. This keeps a repair cheap (you only need to resend the one file you're fixing, not every feature's test code) and keeps a failure in one feature from blocking the others. Use run_test's filePath argument to run and repair one feature's file independently of the others.

${summarizeProjectMap(projectMap)}

Use this index to find the right file to read before writing selectors — prefer it over guessing paths. If a feature you're asked to test isn't listed, use read_file to explore starting from a route or component that seems related.

If a run fails because of a broken selector or similar test-side issue, you may patch that feature's test file and run it again — you have a budget of ${context.orbitConfig.maxRepairAttempts} repair attempts per feature. If a run fails because of an actual application bug (not a problem with the test itself), do not keep patching it — report that feature as failed instead.

Rules:
- Prefer Playwright and role-based selectors (getByRole, getByLabel, getByText).
- Use read_file to look at the actual markup of a component or route before writing selectors against it — do not guess.
- write_test_file only accepts paths inside the project's configured test directory (${context.orbitConfig.testDir}).
- Do not invent project features you have not verified by reading a file.
- Do not attempt to read or use any variables in a .env file.
- Call report_result exactly once, when you are completely done with every feature, with one result entry per feature. Do not stop without calling it.`;
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

// The model reports one status per feature, not one for the whole run — the
// overall status is derived rather than declared, so it can't disagree with
// the individual results.
function deriveOverallStatus(results: FeatureResult[]): AgentRunResult['status'] {
    if (results.length === 0) return 'gave_up';
    return results.every((result) => result.status === 'passed') ? 'passed' : 'failed';
}

function summarizeFeatureResults(results: FeatureResult[]): string {
    if (results.length === 0) return 'No features were reported';
    const passedCount = results.filter((result) => result.status === 'passed').length;
    return `${passedCount}/${results.length} feature(s) passed`;
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
            return {status: 'aborted', summary: 'Aborted by user', results: [], steps};
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
                results: [],
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
                finalResult = {
                    status: deriveOverallStatus(data.results),
                    summary: summarizeFeatureResults(data.results),
                    results: data.results,
                    steps,
                };
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
        results: [],
        steps,
    };
}

const STATUS_LABEL: Record<AgentRunResult['status'], string> = {
    passed: 'Test passed',
    failed: 'Test failed',
    gave_up: 'Gave up',
    aborted: 'Aborted',
};

const FEATURE_STATUS_ICON: Record<FeatureResult['status'], string> = {
    passed: '✓',
    failed: '✗',
    gave_up: '?',
};

// Keyed by file rather than kept as a single "last result" — repeated
// run_test calls scoped to the SAME file (repair iterations) correctly
// overwrite each other here, but calls for DIFFERENT files each keep their
// own latest result instead of the later one silently erasing the earlier
// one's pass/fail data.
function collectRunResultsByFile(steps: AgentStep[]): Map<string, {result: RunTestResult; attempts: number}> {
    const byFile = new Map<string, {result: RunTestResult; attempts: number}>();

    for (let i = 0; i < steps.length; i++) {
        const call = steps[i];
        if (call?.type !== 'tool_call' || call.name !== 'run_test') continue;

        const resultStep = steps[i + 1];
        if (resultStep?.type !== 'tool_result' || !resultStep.result.ok) continue;

        const args = call.args as {filePath?: string | null};
        if (!args.filePath) continue; // whole-suite run — not attributable to one feature

        const existing = byFile.get(args.filePath);
        byFile.set(args.filePath, {
            result: resultStep.result.data as RunTestResult,
            attempts: (existing?.attempts ?? 0) + 1,
        });
    }

    return byFile;
}

export function formatAgentRunResult(result: AgentRunResult): string {
    if (result.results.length === 0) {
        return `${STATUS_LABEL[result.status]}: ${result.summary}`;
    }

    const runResultsByFile = collectRunResultsByFile(result.steps);

    const featureBlocks = result.results.map((feature) => {
        const run = runResultsByFile.get(feature.file);
        const testsText = run
            ? `${run.result.passedCount}/${run.result.totalTests} passed (${run.result.durationMs}ms)`
            : 'not run';
        const attemptsText = run && run.attempts > 1 ? `, ${run.attempts} attempts` : '';

        const failuresText = run && run.result.failures.length > 0
            ? '\n' + run.result.failures.map((failure) => `    - ${failure.testTitle}: ${failure.errorMessage}`).join('\n')
            : '';

        return `${FEATURE_STATUS_ICON[feature.status]} ${feature.feature} (${feature.file}) — ${testsText}${attemptsText}
    ${feature.summary}${failuresText}`;
    });

    return `${STATUS_LABEL[result.status]}: ${result.summary}

${featureBlocks.join('\n\n')}`;
}
