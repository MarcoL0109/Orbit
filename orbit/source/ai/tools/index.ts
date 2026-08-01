import type { FunctionTool } from 'openai/resources/responses/responses';
import { readFileTool } from './readFile.js';
import { writeTestFileTool } from './writeTestFile.js';
import { runTestTool } from './runTest.js';
import { reportResultTool } from './reportResult.js';
import type { ToolDefinition } from './types.js';

export const toolRegistry: ToolDefinition[] = [
    readFileTool,
    writeTestFileTool,
    runTestTool,
    reportResultTool,
];

export function findTool(name: string): ToolDefinition | undefined {
    return toolRegistry.find((tool) => tool.name === name);
}

export function toApiToolSchema(tool: ToolDefinition): FunctionTool {
    return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        // Strict mode requires every property to be listed in `required`
        // (optional fields become nullable instead) — our schemas use plain
        // optional properties (e.g. run_test's filePath), so strict is off.
        strict: false,
    };
}

export { readFileTool, writeTestFileTool, runTestTool, reportResultTool };
export type { RunTestResult, TestFailureDetail } from './runTest.js';
export type { ReportResultArgs } from './reportResult.js';
export type { ToolContext, ToolResult, ToolDefinition } from './types.js';
