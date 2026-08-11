import fs from 'node:fs';
import path from 'node:path';

// Matches graphify's own graph.json shape (a networkx node-link dump) —
// only the fields explain_symbol actually reads, not the full schema.
export type GraphifyNode = {
	label: string;
	file_type: string;
	source_file: string;
	source_location: string;
	id: string;
	norm_label: string;
};

export type GraphifyLink = {
	relation: string;
	confidence: string;
	source: string; // Node id
	target: string; // Node id
};

export type GraphifyGraph = {
	nodes: GraphifyNode[];
	links: GraphifyLink[];
};

function getGraphPath(projectRoot: string): string {
	return path.join(projectRoot, 'graphify-out', 'graph.json');
}

export function graphifyGraphExists(projectRoot: string): boolean {
	return fs.existsSync(getGraphPath(projectRoot));
}

// Keyed by file path, invalidated by mtime — a single test run can call
// explain_symbol many times over the same unchanged graph.json (easily a
// few hundred KB to a few MB), so re-parsing it fresh every call would be
// pure waste. graphify update's own re-extraction between /test runs is
// exactly what busts this: a new mtime on the file means a new read.
const graphCache = new Map<string, {mtimeMs: number; graph: GraphifyGraph}>();

export function loadGraphifyGraph(projectRoot: string): GraphifyGraph | null {
	const graphPath = getGraphPath(projectRoot);

	let stats: fs.Stats;
	try {
		stats = fs.statSync(graphPath);
	} catch {
		return null;
	}

	const cached = graphCache.get(graphPath);
	if (cached && cached.mtimeMs === stats.mtimeMs) {
		return cached.graph;
	}

	try {
		const graph = JSON.parse(
			fs.readFileSync(graphPath, 'utf8'),
		) as GraphifyGraph;
		graphCache.set(graphPath, {mtimeMs: stats.mtimeMs, graph});
		return graph;
	} catch {
		return null;
	}
}

// Exact label/norm_label match first; then the same but ignoring a
// trailing "()" (the model can reasonably type "runTestingAgent" without
// knowing a function node's real label carries the parens); then a loose
// substring match as a last resort. Returns every match at whichever tier
// first produces one — explain_symbol decides what to do with 0, 1, or
// several results, this just ranks candidates.
export function findGraphNodes(
	graph: GraphifyGraph,
	query: string,
): GraphifyNode[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return [];

	const exact = graph.nodes.filter(
		node => node.label === query || node.norm_label === normalizedQuery,
	);
	if (exact.length > 0) return exact;

	const strippedQuery = normalizedQuery.replace(/\(\)$/, '');
	const looseExact = graph.nodes.filter(
		node => node.norm_label.replace(/\(\)$/, '') === strippedQuery,
	);
	if (looseExact.length > 0) return looseExact;

	return graph.nodes.filter(node => node.norm_label.includes(normalizedQuery));
}

export type GraphConnection = {
	direction: 'incoming' | 'outgoing';
	relation: string;
	confidence: string;
	otherLabel: string;
	otherSource: string;
};

export function buildConnections(
	graph: GraphifyGraph,
	node: GraphifyNode,
): GraphConnection[] {
	const nodesById = new Map(
		graph.nodes.map(candidate => [candidate.id, candidate] as const),
	);
	const connections: GraphConnection[] = [];

	for (const link of graph.links) {
		if (link.source === node.id) {
			const target = nodesById.get(link.target);
			connections.push({
				direction: 'outgoing',
				relation: link.relation,
				confidence: link.confidence,
				otherLabel: target?.label ?? link.target,
				otherSource: target
					? `${target.source_file}:${target.source_location}`
					: 'unknown',
			});
		} else if (link.target === node.id) {
			const source = nodesById.get(link.source);
			connections.push({
				direction: 'incoming',
				relation: link.relation,
				confidence: link.confidence,
				otherLabel: source?.label ?? link.source,
				otherSource: source
					? `${source.source_file}:${source.source_location}`
					: 'unknown',
			});
		}
	}

	return connections;
}
