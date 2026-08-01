import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from './types.js';

type ReadFileArgs = {
    path: string;
};

type ReadFileData = {
    content: string;
};

export const readFileTool: ToolDefinition<ReadFileArgs, ReadFileData> = {
    name: 'read_file',
    description:
        'Read the contents of a file within the project, given a path relative to the project root. Use this to inspect a component or route before writing a test against it.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Path relative to the project root',
            },
        },
        required: ['path'],
    },
    execute: async ({path: relativePath}, context) => {
        const resolved = path.resolve(context.projectRoot, relativePath);
        const rootWithSep = context.projectRoot.endsWith(path.sep)
            ? context.projectRoot
            : context.projectRoot + path.sep;

        if (resolved !== context.projectRoot && !resolved.startsWith(rootWithSep)) {
            return {ok: false, error: 'Path escapes the project root'};
        }

        if (!fs.existsSync(resolved)) {
            return {ok: false, error: `File not found: ${relativePath}`};
        }

        try {
            const content = fs.readFileSync(resolved, 'utf8');
            return {ok: true, data: {content}};
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    },
};
