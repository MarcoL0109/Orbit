import type { ResponseInputItem } from 'openai/resources/responses/responses';
import { createOpenAIClient, type ResponsesClient } from './client.js';
import { runAgentTurn, type AgentStep, type AgentProgressEvent, type AgentTurnResult } from './agentLoop.js';
import { readFileTool } from './tools/readFile.js';
import { runCommandTool } from './tools/runCommand.js';
import { signalEnvironmentReadyTool } from './tools/signalEnvironmentReady.js';
import type { EnvironmentSetupContext, ToolDefinition } from './tools/types.js';
import { readEnvironmentSetupInstructions } from '../init/memory.js';

export type { EnvironmentSetupContext } from './tools/types.js';

export type EnvironmentSetupResult = {
    // 'signaled' only means signal_environment_ready was called — NOT proof
    // the environment is actually reachable. This loop can't certify its
    // own success; the caller re-checks reachability independently. See
    // commands.ts's /test wiring.
    status: 'signaled' | 'gave_up' | 'aborted';
    notes: string;
    // Only set when the agent had no documented instructions to follow and
    // wrote its own after figuring the sequence out — see commands.ts,
    // which is what actually persists this to environment_setup.md (only
    // when one didn't already exist, so a human-authored file is never
    // silently overwritten by the agent's own reconstruction of it).
    setupProcedure?: string;
    steps: AgentStep[];
};

export type RunEnvironmentSetupAgentOptions = {
    maxSteps?: number;
    client?: ResponsesClient;
    onProgress?: (event: AgentProgressEvent) => void;
};

const environmentSetupToolRegistry: ToolDefinition<any, any, EnvironmentSetupContext>[] = [
    readFileTool,
    runCommandTool,
    signalEnvironmentReadyTool,
];

function buildSystemPrompt(context: EnvironmentSetupContext, documentedInstructions: string | null): string {
    return `You are Orbit's environment setup agent. Your only job: get this project's dev environment running and reachable at ${context.orbitConfig.baseUrl}, then call signal_environment_ready.

${documentedInstructions
        ? `The user has documented the exact setup sequence for this project — follow it directly rather than exploring from scratch:\n\n${documentedInstructions}`
        : 'No documented setup instructions exist for this project yet. Figure out how to bring it up by reading its own README, docker-compose file, package.json, pyproject.toml, and any other config files with read_file. Once you succeed, you must pass a non-null setupProcedure to signal_environment_ready (see its own description) so the next run does not have to rediscover this from scratch.'}

Rules:
- Every run_command call requires the user's explicit approval — they see the exact command and your reason before it runs. Use the reason well: if a command looks like it could be destructive or hard to undo (seeding data, migrations, anything the project's own docs warn isn't safe to repeat), say so plainly so the user can make an informed call.
- Check state before running anything that might not be safe to repeat (e.g. a database that may already be seeded) rather than assuming a fresh environment every time.
- A command meant to keep running (a dev server, "docker compose up" without -d) must background itself so run_command returns rather than hanging — append &, use nohup, or a daemon/-d flag.
- If a command fails, you'll see its exit code, stdout, and stderr — use that to decide whether to retry, try something else, or give up. A failure is not automatically a dead end.
- Call signal_environment_ready exactly once, as soon as you believe the environment is up — do not try to perfectly verify it yourself first, since reachability is independently re-checked afterward regardless.
- If you get stuck and cannot proceed (a required command was declined, or nothing you try works), stop rather than looping. You do not have to call signal_environment_ready to end the run.`;
}

export async function runEnvironmentSetupAgent(
    context: EnvironmentSetupContext,
    options: RunEnvironmentSetupAgentOptions = {},
): Promise<EnvironmentSetupResult> {
    const maxSteps = options.maxSteps ?? 40;
    const client = options.client ?? createOpenAIClient();
    const steps: AgentStep[] = [];
    const documentedInstructions = readEnvironmentSetupInstructions(context.projectRoot);
    const instructions = buildSystemPrompt(context, documentedInstructions);

    let previousResponseId: string | undefined;
    let nextInput: string | ResponseInputItem[] = 'Get this project\'s dev environment running and reachable.';

    for (let stepCount = 0; stepCount < maxSteps; stepCount++) {
        if (context.signal.aborted) {
            return {status: 'aborted', notes: 'Aborted by user', steps};
        }

        const turn: AgentTurnResult = await runAgentTurn<EnvironmentSetupContext>({
            client,
            model: 'gpt-5.2',
            instructions,
            input: nextInput,
            previousResponseId,
            toolRegistry: environmentSetupToolRegistry,
            context,
            signal: context.signal,
            steps,
            onProgress: options.onProgress,
        });

        previousResponseId = turn.responseId;

        if (turn.functionCalls.length === 0) {
            return {
                status: 'gave_up',
                notes: turn.outputText || 'Agent stopped without signaling readiness',
                steps,
            };
        }

        const signalCall = turn.dispatchedCalls.find((call) => call.name === 'signal_environment_ready');
        if (signalCall && signalCall.result.ok) {
            const data = signalCall.result.data as {notes: string; setupProcedure?: string | null};
            return {status: 'signaled', notes: data.notes, setupProcedure: data.setupProcedure ?? undefined, steps};
        }

        nextInput = turn.outputItems;
    }

    return {
        status: 'gave_up',
        notes: `Stopped after ${maxSteps} steps without signaling readiness`,
        steps,
    };
}
