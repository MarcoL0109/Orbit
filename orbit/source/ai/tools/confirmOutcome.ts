import type { ToolDefinition } from './types.js';

export type ConfirmOutcomeArgs = {
    feature: string;
    whatWasDone: string;
    output: string;
};

export type ConfirmOutcomeResult = {
    outcome: 'success' | 'failure';
};

// The counterpart to request_user_input, but for the opposite direction: not
// asking the user to PROVIDE something the agent can't obtain, but asking
// them to JUDGE something the agent already did and genuinely cannot
// classify itself — after checking browser_action's own apiCalls/
// consoleErrors evidence and still not having a decisive answer. Never asks
// an open question ("what should happen here?") — always presents what was
// done and what happened, then asks for a verdict on that.
//
// Calling this does not by itself satisfy report_result's own confidence
// requirement — see reportResult.ts, which checks hasConfirmedOutcome(feature)
// for any result marked 'uncertain'. That's the actual enforcement; this
// tool just supplies it.
export const confirmOutcomeTool: ToolDefinition<ConfirmOutcomeArgs, ConfirmOutcomeResult> = {
    name: 'confirm_outcome',
    description:
        'Show the user exactly what you did for this feature and what happened, and ask them to judge whether that\'s a success or a failure — for when you genuinely cannot tell yourself, even after checking browser_action\'s apiCalls and consoleErrors fields for decisive evidence. Use this as a last resort, not a substitute for reasoning: a live interaction Playwright may not simulate reliably (drag-and-drop, complex gestures), or a result with no network/console evidence pointing either way, are the kind of case this is for. Do not use it just because a first attempt failed — only when you truly cannot classify the outcome after actually trying to.',
    parameters: {
        type: 'object',
        properties: {
            feature: {
                type: 'string',
                description: 'The exact feature name you will use for this result in report_result — must match precisely, since that\'s how your confirmation gets connected to it.',
            },
            whatWasDone: {
                type: 'string',
                description: 'A clear, specific summary of the actions you took — what you tested and how (e.g. "Wrote a Playwright test that creates 2 questions, then drags the first onto the second to reorder them").',
            },
            output: {
                type: 'string',
                description: 'The actual evidence — the real error message, test output, or observed behavior — not your own interpretation of it. Show the user what you saw, not what you concluded from it.',
            },
        },
        required: ['feature', 'whatWasDone', 'output'],
    },
    execute: async ({feature, whatWasDone, output}, context) => {
        const outcome = await context.requestOutcomeConfirmation(feature, whatWasDone, output);
        return {ok: true, data: {outcome}};
    },
};
