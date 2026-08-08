import { loadGraphifyGraph, findGraphNodes, buildConnections, type GraphConnection } from '../../projects/graphifyGraph.js';
import type { ToolDefinition } from './types.js';

export type ExplainSymbolArgs = {
    label: string;
};

export type ExplainSymbolResult = {
    label: string;
    source: string;
    connections: GraphConnection[];
};

const MAX_LISTED_CANDIDATES = 10;

// Only ever registered when graphify scan mode produced a graph for this
// project (see agent.ts's dynamic registry construction) — the model never
// sees this tool at all otherwise, so execute() failing gracefully here is
// just defense in depth, not the primary guard.
export const explainSymbolTool: ToolDefinition<ExplainSymbolArgs, ExplainSymbolResult> = {
    name: 'explain_symbol',
    description:
        'Look up a function, class, or file by name in this project\'s pre-built code knowledge graph and see exactly what it calls, what calls it, what it imports, and what imports it — each with a file:line reference. Far cheaper than read_file for understanding how something connects to the rest of the codebase. Call this BEFORE read_file on any route, component, or function you have not already explored this run — it is your default first move, not something to reach for only once you notice you need it. Fall back to read_file once you actually need to see the code itself (this tool never shows source, only connections).',
    parameters: {
        type: 'object',
        properties: {
            label: {
                type: 'string',
                description: 'The function, class, or file name to look up, e.g. "runTestingAgent" or "agent.ts". Matching is forgiving (case-insensitive, ignores a trailing "()", falls back to substring) — if more than one symbol matches, they are listed back so you can retry with a more specific label.',
            },
        },
        required: ['label'],
    },
    execute: async ({label}, context) => {
        const graph = loadGraphifyGraph(context.projectRoot);
        if (!graph) {
            return {
                ok: false,
                error: 'No code knowledge graph found for this project — explain_symbol is only available when graphify scan mode is active. Use read_file instead.',
            };
        }

        const matches = findGraphNodes(graph, label);

        if (matches.length === 0) {
            return {
                ok: false,
                error: `No symbol matching "${label}" found in the knowledge graph. Try a different spelling, or use read_file to explore directly.`,
            };
        }

        if (matches.length > 1) {
            const shown = matches.slice(0, MAX_LISTED_CANDIDATES);
            const candidates = shown.map((node) => `${node.label} (${node.source_file}:${node.source_location})`).join(', ');
            const remainder = matches.length - shown.length;
            return {
                ok: false,
                error: `Multiple symbols match "${label}": ${candidates}${remainder > 0 ? `, and ${remainder} more` : ''}. Call again with a more specific label.`,
            };
        }

        const node = matches[0]!;
        return {
            ok: true,
            data: {
                label: node.label,
                source: `${node.source_file}:${node.source_location}`,
                connections: buildConnections(graph, node),
            },
        };
    },
};
