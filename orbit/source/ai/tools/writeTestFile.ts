import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from './types.js';

type WriteTestFileArgs = {
    relativePath: string;
    content: string;
};

type WriteTestFileData = {
    path: string;
};

export const writeTestFileTool: ToolDefinition<WriteTestFileArgs, WriteTestFileData> = {
    name: 'write_test_file',
    description:
        'Write a Playwright test file. The path is relative to the configured test directory — it cannot write anywhere else in the project.',
    parameters: {
        type: 'object',
        properties: {
            relativePath: {
                type: 'string',
                description: 'Path relative to the configured test directory, e.g. "login.spec.ts"',
            },
            content: {
                type: 'string',
                description: 'The full contents of the test file',
            },
        },
        required: ['relativePath', 'content'],
    },
    execute: async ({relativePath, content}, context) => {
        const testDirAbsolute = path.resolve(context.projectRoot, context.orbitConfig.testDir);
        const testDirWithSep = testDirAbsolute.endsWith(path.sep) ? testDirAbsolute : testDirAbsolute + path.sep;
        const resolved = path.resolve(testDirAbsolute, relativePath);

        if (resolved !== testDirAbsolute && !resolved.startsWith(testDirWithSep)) {
            return {ok: false, error: 'Path escapes the configured test directory'};
        }

        if (context.orbitConfig.writeMode === 'ask') {
            const approved = await context.requestApproval(`Write test file: ${path.relative(context.projectRoot, resolved)}`);
            if (!approved) {
                return {ok: false, error: 'User declined the write'};
            }
        }

        try {
            fs.mkdirSync(path.dirname(resolved), {recursive: true});
            fs.writeFileSync(resolved, content, 'utf8');
            return {ok: true, data: {path: resolved}};
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },
};
