import type { FunctionTool } from 'openai/resources/responses/responses';
import { readFileTool } from './readFile.js';
import { writeTestFileTool } from './writeTestFile.js';
import { runTestTool } from './runTest.js';
import { reportResultTool } from './reportResult.js';
import { browserActionTool } from './browserAction.js';
import type { ToolDefinition } from './types.js';

export const toolRegistry: ToolDefinition[] = [
    readFileTool,
    writeTestFileTool,
    runTestTool,
    reportResultTool,
    browserActionTool,
];

export function findTool(name: string): ToolDefinition | undefined {
    return toolRegistry.find((tool) => tool.name === name);
}

export function toApiToolSchema(tool: ToolDefinition): FunctionTool {
    return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        // additionalProperties: false is a strict-mode requirement on every
        // object in the schema — enforced centrally here rather than by each
        // tool, so it can't be forgotten. Individual tools are still
        // responsible for their own strict-mode compliance on optional
        // fields (list them in `required` with a nullable type instead of
        // omitting them — see run_test's filePath for the pattern).
        parameters: {
            ...tool.parameters,
            additionalProperties: false,
        },
        strict: true,
    };
}

export { readFileTool, writeTestFileTool, runTestTool, reportResultTool, browserActionTool };
export type { RunTestResult, TestFailureDetail } from './runTest.js';
export type { ReportResultArgs } from './reportResult.js';
export type { BrowserActionArgs } from './browserAction.js';
export type { ToolContext, ToolResult, ToolDefinition } from './types.js';
