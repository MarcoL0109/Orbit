import type { ToolDefinition } from './types.js';

export type ReportResultArgs = {
    status: 'passed' | 'failed' | 'gave_up';
    summary: string;
    filesWritten: string[];
};

// The loop's only terminal tool. The model must call this exactly once to
// end the run — no tool call at all is treated as an error, not a finish
// (see agent.ts). This forces a structured status/summary instead of free
// prose, which is what lets the CLI color-code the outcome and log it.
export const reportResultTool: ToolDefinition<ReportResultArgs, ReportResultArgs> = {
    name: 'report_result',
    description: 'Call this exactly once, when finished, to report the final outcome of the task.',
    parameters: {
        type: 'object',
        properties: {
            status: {
                type: 'string',
                enum: ['passed', 'failed', 'gave_up'],
                description: '"passed" if the test now passes, "failed" if it does not and no more repair attempts remain, "gave_up" if the task could not be completed at all',
            },
            summary: {
                type: 'string',
                description: 'A short human-readable summary of what happened',
            },
            filesWritten: {
                type: 'array',
                items: {type: 'string'},
                description: 'Paths (relative to the test directory) of any test files written during this run',
            },
        },
        required: ['status', 'summary', 'filesWritten'],
    },
    execute: async (args) => ({ok: true, data: args}),
};
