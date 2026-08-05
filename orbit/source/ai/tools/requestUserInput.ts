import type { ToolDefinition } from './types.js';

export type RequestUserInputArgs = {
    prompt: string;
};

export type RequestUserInputResult = {
    value: string;
};

// Pauses the run and waits on the user, mirroring run_test/write_test_file's
// approval gate — same mechanism (a Promise the Ink UI resolves), just
// collecting text instead of a yes/no. Only for information genuinely
// unobtainable through read_file or browser_action: an external code, a
// secret only the user has.
export const requestUserInputTool: ToolDefinition<RequestUserInputArgs, RequestUserInputResult> = {
    name: 'request_user_input',
    description:
        'Ask the user to type in a piece of information you cannot obtain any other way — a verification/activation code sent externally (email, SMS), a secret only they have, or similar. Only call this once you have actually explored the flow with browser_action and hit a point you genuinely cannot pass without it — never speculatively or before attempting anything, since a decline still means everything explored up to that point (including any real side effect it triggered, like sending an email) already happened for nothing. It pauses the run until the user responds, and they may decline.',
    parameters: {
        type: 'object',
        properties: {
            prompt: {
                type: 'string',
                description: 'Clear description of what you need and why, shown directly to the user (e.g. "Enter the 6-digit activation code just emailed to test@example.com").',
            },
        },
        required: ['prompt'],
    },
    execute: async ({prompt}, context) => {
        if (!context.hasExploredWithBrowser()) {
            return {
                ok: false,
                error: 'Explore this flow live with browser_action first — navigate to the relevant page and attempt the steps leading up to this point — before asking the user for anything. Do not request input before you have actually attempted a browser_action call this run.',
            };
        }

        const value = await context.requestInput(prompt);

        if (value === null) {
            return {ok: false, error: 'User declined to provide the requested input'};
        }

        return {ok: true, data: {value}};
    },
};
