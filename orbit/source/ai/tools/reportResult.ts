import type { ToolDefinition } from './types.js';

export type FeatureResult = {
    feature: string;
    file: string;
    status: 'passed' | 'failed' | 'gave_up';
    summary: string;
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
                            type: 'string',
                            description: 'Path (relative to the test directory) of the test file written for this feature',
                        },
                        status: {
                            type: 'string',
                            enum: ['passed', 'failed', 'gave_up'],
                            description: '"passed" if this feature\'s test now passes, "failed" if it does not and no more repair attempts remain for it, "gave_up" if this feature could not be tested at all',
                        },
                        summary: {
                            type: 'string',
                            description: 'One or two sentences on this feature\'s outcome',
                        },
                    },
                    required: ['feature', 'file', 'status', 'summary'],
                    additionalProperties: false,
                },
            },
        },
        required: ['results'],
    },
    execute: async (args) => ({ok: true, data: args}),
};
