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

// A source-file extension is a stronger, still framework-agnostic signal
// than merely "doesn't end in ()" — a file's own constants (SUGGESTIONS,
// STATE_TONE, ...) don't look like a callable either, but they don't look
// like a path at all, whereas the file's own module-level node's label
// always does (it's graphify's prefix-stripped form of the real path).
// Not exhaustive, but broad enough across the languages graphify actually
// parses to be a reliable disambiguator rather than a guess.
const FILE_LABEL_EXTENSION =
	/\.(tsx?|jsx?|mjs|cjs|py|rb|go|java|kt|swift|vue|svelte|c|cc|cpp|h|hpp|cs|php|rs)$/i;

// A path-based match (below) naming a whole file — its most common form, a
// route or component path taken straight from the project map — matches
// every node graphify extracted from that file, not just one: the file's
// own module-level node plus one per function/class/constant inside it.
// When they all share a single source_file, the model almost always meant
// the file itself, not one of its members — narrow to whichever of those
// nodes has a file-extension-shaped label, which is exactly how graphify's
// own file-level nodes come out. Left alone (every candidate returned) if
// that doesn't resolve to exactly one node, or if the matches actually
// span more than one file — a genuinely ambiguous query, e.g. a bare
// "page.tsx" that exists under several routes, still needs the caller to
// disambiguate.
function preferFileLevelNode(nodes: GraphifyNode[]): GraphifyNode[] {
	if (nodes.length <= 1) return nodes;

	const distinctFiles = new Set(nodes.map(node => node.source_file));
	if (distinctFiles.size > 1) return nodes;

	const fileShaped = nodes.filter(node =>
		FILE_LABEL_EXTENSION.test(node.label),
	);
	return fileShaped.length === 1 ? fileShaped : nodes;
}

// Exact label/norm_label match first; then an exact match against the
// node's real file path (source_file) — separate from label, and worth
// trying before any fuzzy label matching, because graphify's own label
// generation strips a leading path segment inconsistently (observed: it
// drops a Next.js "app/" router prefix from most page files' labels, but
// keeps it for the root "app/page.tsx"). The model routinely knows and
// passes the real path (e.g. from a route list) rather than graphify's
// internal label, and that path is project-layout-agnostic — this isn't
// "strip app/" hardcoded for one framework, it's matching against a field
// every graphify project already records regardless of its own
// conventions. Then the same label tier again but ignoring a trailing "()"
// (the model can reasonably type "runTestingAgent" without knowing a
// function node's real label carries the parens); then a path suffix match
// (so "contacts/page.tsx" still finds a node whose source_file is
// "app/contacts/page.tsx", without needing to guess the exact prefix); then
// a loose label substring match as a last resort. Returns every match at
// whichever tier first produces one — explain_symbol decides what to do
// with 0, 1, or several results, this just ranks candidates.
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

	const exactPath = graph.nodes.filter(
		node => node.source_file.toLowerCase() === normalizedQuery,
	);
	if (exactPath.length > 0) return preferFileLevelNode(exactPath);

	const strippedQuery = normalizedQuery.replace(/\(\)$/, '');
	const looseExact = graph.nodes.filter(
		node => node.norm_label.replace(/\(\)$/, '') === strippedQuery,
	);
	if (looseExact.length > 0) return looseExact;

	const pathSuffix = graph.nodes.filter(node => {
		const sourceFile = node.source_file.toLowerCase();
		return (
			sourceFile.endsWith(`/${normalizedQuery}`) ||
			sourceFile.endsWith(`\\${normalizedQuery}`)
		);
	});
	if (pathSuffix.length > 0) return preferFileLevelNode(pathSuffix);

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
