import type { ToolDefinition } from './types.js';

export type FeatureResult = {
    feature: string;
    // Null when requiresManualInput is true and no test file was written —
    // a persisted test for a flow gated behind manually-supplied, single-use
    // external input (an emailed code, etc.) can't pass unattended on a
    // future run, and reaching the same point again would repeat whatever
    // real side effect that step has (e.g. sending another real email) every
    // time it runs. Non-null otherwise.
    file: string | null;
    status: 'passed' | 'failed' | 'gave_up';
    summary: string;
    // True if this feature's test needed request_user_input to get past a
    // step it can't automate unattended (e.g. a one-time code). status still
    // reflects the run's actual pass/fail — this only flags that a human was
    // involved, so a "passed" run doesn't get mistaken for a fully
    // unattended-repeatable one.
    requiresManualInput: boolean;
    // The manually-assisted step's own outcome, kept separate from `status`
    // since the two can diverge (e.g. the manual step succeeded but a later,
    // unrelated assertion failed). Non-null exactly when requiresManualInput
    // is true — this is what actually answers "did the manual part work",
    // not just prose in `summary` that the model might forget to include.
    manualStepOutcome: 'succeeded' | 'failed' | null;
};

export type ReportResultArgs = {
    results: FeatureResult[];
};

// The loop's only terminal tool. The model must call this exactly once to
// end the run — no tool call at all is treated as an error, not a finish
// (see agent.ts). One result per feature, since features get separate test
// files (see the system prompt) and can independently pass/fail.
export const reportResultTool: ToolDefinition<ReportResultArgs, ReportResultArgs> = {
    name: 'report_result',
    description: 'Call this exactly once, when finished with every feature, to report the outcome of each one.',
    parameters: {
        type: 'object',
        properties: {
            results: {
                type: 'array',
                description: 'One entry per feature you were asked to test.',
                items: {
                    type: 'object',
                    properties: {
                        feature: {
                            type: 'string',
                            description: 'Short name of the feature, e.g. "login"',
                        },
                        file: {
                            type: ['string', 'null'],
                            description: 'Path (relative to the test directory) of the test file written for this feature, or null if requiresManualInput is true and you deliberately did not write one (see requiresManualInput).',
                        },
                        status: {
                            type: 'string',
                            enum: ['passed', 'failed', 'gave_up'],
                            description: '"passed" if this feature\'s test now passes, "failed" if it does not and no more repair attempts remain for it, "gave_up" if this feature could not be tested at all',
                        },
                        summary: {
                            type: 'string',
                            description: 'One or two sentences on this feature\'s outcome.',
                        },
                        requiresManualInput: {
                            type: 'boolean',
                            description: 'true if you called request_user_input anywhere while testing this feature, false otherwise.',
                        },
                        manualStepOutcome: {
                            type: ['string', 'null'],
                            enum: ['succeeded', 'failed'],
                            description: 'Whether the manually-assisted step itself worked once given the value (e.g. the activation code actually activated the account) — not the overall test status. Required (non-null) when requiresManualInput is true; must be null when it is false.',
                        },
                    },
                    required: ['feature', 'file', 'status', 'summary', 'requiresManualInput', 'manualStepOutcome'],
                    additionalProperties: false,
                },
            },
        },
        required: ['results'],
    },
    execute: async (args) => ({ok: true, data: args}),
};
