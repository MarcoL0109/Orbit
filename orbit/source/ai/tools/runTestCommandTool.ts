import {runTestCommand} from '../../commands/testCommand.js';
import type {CommandContext} from '../../commands/context.js';
import type {AgentRunResult} from '../agent.js';
import type {ToolDefinition} from './types.js';

export type RunTestCommandArgs = {
	prompt: string;
};

export type RunTestCommandData = {
	status: AgentRunResult['status'];
	summary: string;
};

type RunTestCommandContext = CommandContext & {
	projectRoot: string;
	signal: AbortSignal;
};

// The one tool in ask mode with real side effects: writes a real Playwright
// test file and runs it against the live app, exactly like a human typing
// /test themselves (it calls the exact same runTestCommand /test's own
// handler does). Every single call requires explicit approval before it
// runs, with no way around it — the check happens right at the top of
// execute(), before runTestCommand does anything at all, so a declined
// call costs nothing and never touches the project.
export const runTestCommandTool: ToolDefinition<
	RunTestCommandArgs,
	RunTestCommandData,
	RunTestCommandContext
> = {
	name: 'run_test_command',
	description:
		'Run the real /test command: generate and run a Playwright test for the feature described in `prompt`, writing a real test file and actually exercising the live app (may also bring up the dev environment first). Has real side effects, unlike every other tool available in this mode — every single call asks the user for approval before it runs, with no exceptions. Only use this when the question genuinely requires actually testing or verifying something live; prefer read_file/explain_symbol/check_coverage for anything that does not need a real run.',
	parameters: {
		type: 'object',
		properties: {
			prompt: {
				type: 'string',
				description:
					'The feature description to test, exactly as you would pass it to /test — e.g. "user can log in with valid credentials and sees the dashboard".',
			},
		},
		required: ['prompt'],
	},
	async execute({prompt}, context) {
		const approved = await context.requestApproval(
			`Run /test: "${prompt}"\n(Writes a real Playwright test file and runs it against the live app.)`,
		);
		if (!approved) {
			return {ok: false, error: 'User declined to run this test'};
		}

		const outcome = await runTestCommand(prompt, context, context.signal);

		return outcome.ranTest
			? {
					ok: true,
					data: {status: outcome.status, summary: outcome.summary},
			  }
			: {ok: false, error: outcome.reason};
	},
};
