import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from './types.js';
import { checksumFromContent } from '../../projects/checksum.js';
import { getFreshClassification, recordClassification } from '../../projects/featureClassification.js';
import { classifyFileFeatures } from '../classifyFeature.js';

type ReadFileArgs = {
    path: string;
};

type ReadFileData = {
    content: string;
};

// Only files worth asking "what feature does this implement" — classifying
// a package.json or README this way would just waste an API call for an
// answer that's always "none". Mirrors the SOURCE_EXTENSIONS set scan.ts
// and path.ts each keep locally for their own equivalent purpose.
const CLASSIFIABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);

// Only ever touches projectRoot/signal — declared against that minimal
// shape rather than the full ToolContext, so it can be reused as-is by any
// agent whose context has at least those two fields (see the environment
// setup agent, whose context is much smaller than ToolContext).
export const readFileTool: ToolDefinition<ReadFileArgs, ReadFileData, {projectRoot: string; signal: AbortSignal}> = {
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

        let content: string;

        try {
            content = fs.readFileSync(resolved, 'utf8');
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }

        // Piggyback feature classification: best-effort, checksum-cached,
        // and must never fail the read itself — a classification failure
        // just means coverage stays at heuristic confidence for this file.
        if (CLASSIFIABLE_EXTENSIONS.has(path.extname(relativePath))) {
            try {
                const checksum = checksumFromContent(content);
                const cached = getFreshClassification(context.projectRoot, relativePath, checksum);

                if (!cached) {
                    const classification = await classifyFileFeatures(
                        relativePath,
                        content,
                        undefined,
                        context.signal,
                    );
                    recordClassification(context.projectRoot, relativePath, checksum, classification.features);
                }
            } catch {
                // Classification is a bonus, not a requirement.
            }
        }

        return {ok: true, data: {content}};
    },
};
