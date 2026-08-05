import fs from 'node:fs';
import path from 'node:path';
import type { Response, ResponseFunctionToolCall, ResponseInputItem } from 'openai/resources/responses/responses';
import { createOpenAIClient, type ResponsesClient } from './client.js';
import { toolRegistry, findTool, toApiToolSchema, type ToolContext, type ToolResult } from './tools/index.js';
import { spawnBrowserWorker, type BrowserWorkerHandle } from './browserWorker.js';
import type { ReportResultArgs, FeatureResult } from './tools/reportResult.js';
import type { RunTestResult, TestOutcome, TestStatus, TestFailureDetail } from './tools/runTest.js';
import { readProjectMap, type ProjectMap } from '../projects/scan.js';
import { readProjectMemory, type ProjectMemory } from '../init/memory.js';
import { readFeatureClassifications } from '../projects/featureClassification.js';
import { checksumFromContent } from '../projects/checksum.js';

export type { ResponsesClient } from './client.js';

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
    browser_action: 'Exploring the page...',
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

// Files this run has already written, read straight from the loop's own
// `steps` — no rescan, no hash, no freshness check needed. The run just
// did this itself, moments ago; there's nothing to verify.
function collectTestsWrittenThisRun(steps: AgentStep[], projectRoot: string): string[] {
    const files = new Set<string>();

    for (const step of steps) {
        if (step.type === 'tool_result' && step.name === 'write_test_file' && step.result.ok) {
            const data = step.result.data as {path: string};
            files.add(path.relative(projectRoot, data.path));
        }
    }

    return [...files];
}

// Reuses whatever /scan already computed instead of leaving the model to
// guess file paths blind — read_file still exists for the actual deep dive
// once it knows which file is relevant. extraTestFiles covers the one gap
// the last /scan can't: test files this run has itself written since that
// scan ran, which won't be in projectMap yet.
function summarizeProjectMap(projectMap: ProjectMap | null, extraTestFiles: string[]): string {
    if (!projectMap) {
        return 'No project index available yet (run /scan first for a list of known routes and components) — you will need to find files by informed guesswork.';
    }

    const routes = projectMap.routes.map((route) => `- ${route.route} -> ${route.file}`);
    const components = projectMap.components.map((component) => `- ${component.name} -> ${component.file}`);

    const knownTestFiles = new Set(projectMap.tests.map((test) => test.file));
    const tests = [
        ...projectMap.tests.map((test) => `- ${test.file}`),
        ...extraTestFiles
            .filter((file) => !knownTestFiles.has(file))
            .map((file) => `- ${file} (written this run)`),
    ];

    return `Known project structure (from the last /scan, ${projectMap.generatedAt}):

Routes:
${formatList(routes)}

Components:
${formatList(components)}

Existing tests:
${formatList(tests)}`;
}

// Everything already confirmed by content — from this project's own
// classification cache, built up as a side effect of past read_file and
// write_test_file calls — grouped by feature so the model can go straight
// to a known file instead of re-discovering it by trial and error. Only
// entries still fresh (checksum matches the file's current state) are
// shown; a stale one would just be misleading a wrong lead.
function summarizeKnownClassifications(projectRoot: string): string {
    const classifications = readFeatureClassifications(projectRoot);
    const filesByFeature = new Map<string, string[]>();

    for (const [file, entry] of Object.entries(classifications.entries)) {
        // Checked against the file's actual current content, not
        // checksums.json — that file is only refreshed by a full project
        // scan, which doesn't happen between turns within a run, so it
        // wouldn't know about anything classified earlier THIS run (like a
        // test file write_test_file just wrote). Hashing directly is cheap
        // here since it's only ever the bounded set of already-classified
        // files, not a full-project walk.
        let currentChecksum: string | null = null;

        try {
            currentChecksum = checksumFromContent(fs.readFileSync(path.join(projectRoot, file)));
        } catch {
            continue; // file no longer exists or isn't readable — treat as stale
        }

        if (currentChecksum !== entry.checksum) continue;

        for (const feature of entry.features) {
            const files = filesByFeature.get(feature) ?? [];
            files.push(file);
            filesByFeature.set(feature, files);
        }
    }

    if (filesByFeature.size === 0) {
        return 'None yet — nothing has been classified by feature so far.';
    }

    const lines = [...filesByFeature.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([feature, files]) => `- ${feature}: ${files.join(', ')}`);

    return formatList(lines);
}

// Purely additive context — nothing here is enforced in code, it's the
// project's own accumulated notes and conventions, handed to the model as
// background before it writes anything.
function summarizeMemory(memory: ProjectMemory): string {
    const sections = [
        memory.overview && `## Project overview\n${memory.overview}`,
        memory.decisions && `## Testing decisions and conventions\n${memory.decisions}`,
        memory.failures && `## Known failure patterns\n${memory.failures}`,
    ].filter((section): section is string => Boolean(section));

    return sections.length > 0 ? sections.join('\n\n') : 'No project memory recorded yet.';
}

function buildSystemPrompt(
    context: ToolContext,
    projectMap: ProjectMap | null,
    memory: ProjectMemory,
    knownClassifications: string,
    testsWrittenThisRun: string[],
): string {
    return `You are Orbit, an AI QA agent for E2E testing.

Your job: given a description of one or more features to test, write a Playwright test for each feature using the write_test_file tool, then run it using the run_test tool.

If the prompt describes multiple distinct features, group the features according to the cateogories as there maybe sub-features within a single feature. Group those sub-feature in a single test file — do not combine multiple features into a single file. This keeps a repair cheap (you only need to resend the one file you're fixing, not every feature's test code) and keeps a failure in one feature from blocking the others. Use run_test's filePath argument to run and repair one feature's file independently of the others.

${summarizeProjectMap(projectMap, testsWrittenThisRun)}

Files already confirmed by feature (from past runs — read the file directly if what you need is listed here, instead of exploring blind):
${knownClassifications}

Use the project index above to find the right file to read before writing selectors — prefer it over guessing paths. If a feature you're asked to test isn't listed anywhere, use read_file to explore starting from a route or component that seems related.

Project memory (read this before writing anything — avoid repeating documented failure patterns and follow documented conventions):

${summarizeMemory(memory)}

If a run fails because of a broken selector or similar test-side issue, you may patch that feature's test file and run it again — you have a budget of ${context.orbitConfig.maxRepairAttempts} repair attempts per feature. If a run fails because of an actual application bug (not a problem with the test itself), do not keep patching it — report that feature as failed instead.

Exploring with a real browser (browser_action): read_file shows you source code, not what actually renders — runtime data, conditional branches, and component-library internals can all make the real page different from what the source suggests. Use browser_action to ground your selectors and expected outcomes in what you actually observe, especially for anything read_file can't tell you: content behind a login, a multi-step flow with no direct URL per step, or a state that only appears after an interaction (a toast, a modal, a cart badge). navigate/click/fill already return the resulting accessibility snapshot whenever the page actually changed — you don't need to separately call snapshot after them. Call snapshot on its own only to re-check the current state without taking a new action. Call reset when you start exploring a NEW feature (fresh cookies/storage) — do not call it between pages within the same feature's flow, since a multi-page journey (e.g. cart -> checkout -> payment) depends on staying in the same browser context throughout.

Rules:
- Prefer Playwright and role-based selectors (getByRole, getByLabel, getByText).
- Use read_file to look at the actual markup of a component or route before writing selectors against it — do not guess. Use browser_action when you need to see what's actually rendered, not just what the source suggests.
- write_test_file only accepts paths inside the project's configured test directory (${context.orbitConfig.testDir}).
- write_test_file's features argument: short, lowercase, dot-separated names (e.g. "checkout", "checkout.payment") — a broad feature and, where it genuinely applies, a specific sub-feature, matching the same convention used in the project index above. List every sub-feature the file covers if it groups more than one. Keep this accurate on every call, including repair retries — it's used for coverage tracking, not just documentation.
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
    context: Omit<ToolContext, 'getBrowserWorker'>,
    options: RunTestingAgentOptions = {},
): Promise<AgentRunResult> {
    const maxSteps = options.maxSteps ?? 20;
    const client = options.client ?? createOpenAIClient();
    const steps: AgentStep[] = [];

    // Owned by the run, not by any individual tool call — lazily spawned on
    // first use, reused across every feature in this run (paying the launch
    // cost once), respawned if it crashed, and always closed below
    // regardless of how the run ends. A ref-cell object rather than a bare
    // `let`, since a `let` reassigned only inside a nested closure confuses
    // TS's narrowing at the finally block below.
    const browserWorkerRef: {current: BrowserWorkerHandle | null} = {current: null};
    const toolContext: ToolContext = {
        ...context,
        getBrowserWorker: async () => {
            if (!browserWorkerRef.current || !browserWorkerRef.current.isAlive()) {
                browserWorkerRef.current = spawnBrowserWorker(context.projectRoot, context.orbitConfig.defaultBrowser);
            }
            return browserWorkerRef.current;
        },
    };

    let previousResponseId: string | undefined;
    let nextInput: string | ResponseInputItem[] = prompt;

    try {
        for (let stepCount = 0; stepCount < maxSteps; stepCount++) {
            if (context.signal.aborted) {
                return {status: 'aborted', summary: 'Aborted by user', results: [], steps};
            }

            // Re-read fresh every turn, not once before the loop — a tool call
            // earlier in this same run (e.g. write_test_file classifying a
            // shared component while working on a different feature) should be
            // visible to later turns, not just to the next run. This costs
            // nothing extra: the API never carries `instructions` across
            // previous_response_id chaining regardless (each call's
            // instructions fully replaces the last, confirmed via the SDK's
            // own docs), so there was never a reason for this to be a fixed
            // snapshot in the first place.
            const projectMap = readProjectMap(context.projectRoot);
            const memory = readProjectMemory(context.projectRoot);
            const knownClassifications = summarizeKnownClassifications(context.projectRoot);
            const testsWrittenThisRun = collectTestsWrittenThisRun(steps, context.projectRoot);

            const response = await client.responses.create({
                model: 'gpt-5.2',
                instructions: buildSystemPrompt(toolContext, projectMap, memory, knownClassifications, testsWrittenThisRun),
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
                    ? await tool.execute(args, toolContext)
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
    } finally {
        browserWorkerRef.current?.close();
    }
}

const STATUS_LABEL: Record<AgentRunResult['status'], string> = {
    passed: 'Test passed',
    failed: 'Test failed',
    gave_up: 'Gave up',
    aborted: 'Aborted',
};

const TEST_STATUS_ICON: Record<TestStatus, string> = {
    passed: '✓',
    failed: '✘',
    timedOut: '✘',
    skipped: '○',
    other: '?',
};

// Playwright-style: one line per test, not just an aggregate count or a
// failures-only list — this is what run_test's full per-test data (not
// just failures) was extended to support.
function formatTestList(tests: TestOutcome[], failures: TestFailureDetail[]): string {
    const errorByTitle = new Map(failures.map((failure) => [failure.testTitle, failure.errorMessage]));

    return tests
        .map((test) => {
            const line = `    ${TEST_STATUS_ICON[test.status]} ${test.title} (${test.durationMs}ms)`;
            const errorMessage = errorByTitle.get(test.title);
            return errorMessage ? `${line}\n        ${errorMessage}` : line;
        })
        .join('\n');
}

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

        const testListText = run && run.result.tests.length > 0
            ? '\n' + formatTestList(run.result.tests, run.result.failures)
            : '';

        return `${FEATURE_STATUS_ICON[feature.status]} ${feature.feature} (${feature.file}) — ${testsText}${attemptsText}
    ${feature.summary}${testListText}`;
    });

    return `${STATUS_LABEL[result.status]}: ${result.summary}

${featureBlocks.join('\n\n')}`;
}
