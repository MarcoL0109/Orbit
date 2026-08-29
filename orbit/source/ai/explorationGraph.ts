import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {getOrbitDir} from '../init/orbitDir.js';

// Built purely from what browser_action actually observes during blind-mode
// exploration — the closest thing a blind project has to graphify's own
// code-derived project map, except discovered empirically instead of read
// from source. Node = a distinct page/state; edge = the action that got
// from one to another. See browserAction.ts for where this gets built, and
// summarizeExplorationGraph below for how it's fed back to the model.
export type ExplorationNode = {
	id: string;
	url: string;
	// Best-effort — the real page <title> (already computed by Playwright
	// itself, via browser_action's response), not something derived here.
	label: string;
	firstSeenAt: string;
	lastConfirmedAt: string;
};

export type ExplorationAction = {
	type: 'navigate' | 'click' | 'fill' | 'selectOption' | 'press' | 'hover';
	selector: string | null;
	value: string | null;
};

export type ExplorationEdge = {
	id: string;
	from: string;
	to: string;
	action: ExplorationAction;
	verifiedCount: number;
	lastConfirmedAt: string;
	// Set the first time a replay of this exact action from `from` lands
	// somewhere other than `to` — kept, not deleted, so one bad observation
	// doesn't erase real history; just excluded from what gets surfaced
	// until it's reconfirmed. See recordTransition.
	staleSince: string | null;
};

export type ExplorationGraph = {
	version: 1;
	nodes: ExplorationNode[];
	edges: ExplorationEdge[];
};

function emptyGraph(): ExplorationGraph {
	return {version: 1, nodes: [], edges: []};
}

function getExplorationGraphPath(projectRoot: string): string {
	return path.join(getOrbitDir(projectRoot), 'index', 'exploration-graph.json');
}

export function readExplorationGraph(projectRoot: string): ExplorationGraph {
	const graphPath = getExplorationGraphPath(projectRoot);

	if (!fs.existsSync(graphPath)) {
		return emptyGraph();
	}

	const raw = fs.readFileSync(graphPath, 'utf8');

	if (!raw.trim()) {
		return emptyGraph();
	}

	try {
		return JSON.parse(raw) as ExplorationGraph;
	} catch {
		return emptyGraph();
	}
}

export function writeExplorationGraph(
	projectRoot: string,
	graph: ExplorationGraph,
): void {
	const graphPath = getExplorationGraphPath(projectRoot);

	fs.mkdirSync(path.dirname(graphPath), {recursive: true});
	fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2), 'utf8');
}

// Extracts {role, name} pairs from a Playwright ARIA-snapshot line like
// `  - link "Home menu" [ref=f2e6] [cursor=pointer]:` -> role "link", name
// "Home menu". A leaf line with no quoted name (`- generic [ref=f2e1]:`)
// still contributes its role alone. Deliberately coarse: this is meant to
// recognize "the same page" across runs despite dynamic IDs/timestamps/
// whichever record happens to be showing, not to capture literal content.
const SNAPSHOT_LINE_PATTERN = /^\s*-\s*([a-zA-Z][a-zA-Z0-9]*)(?:\s+"([^"]*)")?/;

// A trailing count baked directly into the accessible name — "Messages 2",
// "Activities 21" (both real values seen in this session's own RicardoLighting
// snapshots) — is exactly the kind of incidental content this fingerprint is
// meant to see past; the label is what matters ("Messages"), not how many
// there happen to be right now. Stripped before hashing so a badge count
// changing between visits doesn't fingerprint as a different page.
function normalizeName(name: string): string {
	return name.replace(/\s+\d+$/, '');
}

function extractRoleNamePairs(snapshotText: string): string[] {
	const pairs: string[] = [];

	for (const line of snapshotText.split('\n')) {
		const match = SNAPSHOT_LINE_PATTERN.exec(line);
		if (match) {
			const name = match[2] ? normalizeName(match[2]) : '';
			pairs.push(`${match[1]}:${name}`);
		}
	}

	return pairs;
}

// A short, stable hash of the page's structural shape — same set of
// role/name pairs present, order and duplicates irrelevant. Two visits
// fingerprint identically if the same controls/labels are on screen,
// regardless of which record's data happens to be showing; two visits
// showing genuinely different controls fingerprint differently even at
// the same URL, which plain URL-keying can't distinguish for an SPA.
export function fingerprintSnapshot(snapshotText: string): string {
	const uniqueSorted = [...new Set(extractRoleNamePairs(snapshotText))].sort();
	return createHash('sha256')
		.update(uniqueSorted.join('|'))
		.digest('hex')
		.slice(0, 16);
}

function hashId(...parts: string[]): string {
	return createHash('sha256')
		.update(parts.join('|'))
		.digest('hex')
		.slice(0, 16);
}

// Node identity: url + structural fingerprint together, not either alone —
// see this module's own design notes. Neither url-only (an SPA can show
// very different states at the same URL) nor fingerprint-only (two
// genuinely different routes can coincidentally share a similar shape)
// captures "the same page" on its own.
function deriveNodeId(url: string, fingerprint: string): string {
	return hashId(url, fingerprint);
}

// Includes `to`, not just (from, action) — two edges sharing the same
// origin and action but leading to DIFFERENT destinations are genuinely
// different edges (that's exactly the staleness case: the same action used
// to lead one place, now leads another) and must not collide on one id.
function deriveEdgeId(
	fromNodeId: string,
	action: ExplorationAction,
	toNodeId: string,
): string {
	return hashId(
		fromNodeId,
		action.type,
		action.selector ?? '',
		action.value ?? '',
		toNodeId,
	);
}

function actionsMatch(a: ExplorationAction, b: ExplorationAction): boolean {
	return a.type === b.type && a.selector === b.selector && a.value === b.value;
}

function upsertNode(
	graph: ExplorationGraph,
	id: string,
	url: string,
	label: string,
	now: string,
): void {
	const existing = graph.nodes.find(node => node.id === id);

	if (existing) {
		existing.lastConfirmedAt = now;
		return;
	}

	graph.nodes.push({id, url, label, firstSeenAt: now, lastConfirmedAt: now});
}

// Called once per browser_action that actually changed the page (see
// browserAction.ts) — mutates and returns the same graph object in place
// (the caller owns read/write to disk; this is the pure transition logic).
// fromNodeId is null for the very first transition of a run (nothing to
// draw an edge from yet); the returned toNodeId becomes the caller's next
// fromNodeId.
export function recordTransition(
	graph: ExplorationGraph,
	parameters: {
		fromNodeId: string | null;
		action: ExplorationAction;
		url: string;
		title: string;
		snapshot: string;
	},
): {graph: ExplorationGraph; toNodeId: string} {
	const now = new Date().toISOString();
	const fingerprint = fingerprintSnapshot(parameters.snapshot);
	const toNodeId = deriveNodeId(parameters.url, fingerprint);

	upsertNode(graph, toNodeId, parameters.url, parameters.title, now);

	if (parameters.fromNodeId) {
		const fromNodeId = parameters.fromNodeId;
		const sameOriginAndAction = (edge: ExplorationEdge) =>
			edge.from === fromNodeId && actionsMatch(edge.action, parameters.action);

		// Whatever this action leads to right now is the truth — any OTHER
		// destination already on file for the same (from, action) is
		// superseded by this fresh observation, whether or not this exact
		// destination has been seen before.
		for (const edge of graph.edges) {
			if (sameOriginAndAction(edge) && edge.to !== toNodeId) {
				edge.staleSince = now;
			}
		}

		const matchingDestination = graph.edges.find(
			edge => sameOriginAndAction(edge) && edge.to === toNodeId,
		);

		if (matchingDestination) {
			matchingDestination.verifiedCount += 1;
			matchingDestination.lastConfirmedAt = now;
			matchingDestination.staleSince = null;
		} else {
			graph.edges.push({
				id: deriveEdgeId(fromNodeId, parameters.action, toNodeId),
				from: fromNodeId,
				to: toNodeId,
				action: parameters.action,
				verifiedCount: 1,
				lastConfirmedAt: now,
				staleSince: null,
			});
		}
	}

	return {graph, toNodeId};
}

// A stale-marked edge, or one nobody's revisited in a long time, is worse
// than useless to surface — it'd read as an equally-trustworthy suggestion
// alongside genuinely fresh ones. Read-time filtering, not deletion: the
// underlying file keeps the full history regardless.
const STALE_EDGE_MAX_AGE_DAYS = 30;

function isEdgeFreshEnoughToSurface(edge: ExplorationEdge, now: Date): boolean {
	if (edge.staleSince) return false;

	const ageMs = now.getTime() - new Date(edge.lastConfirmedAt).getTime();
	return ageMs <= STALE_EDGE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

const MAX_SURFACED_EDGES = 40;

// A compact adjacency-list view for the system prompt — capped, not a full
// dump, for the same reason MAX_PAGE_SNAPSHOT_CHARS exists elsewhere: this
// accumulates across every run against this project, so an unbounded dump
// would eventually dominate the prompt on its own.
export function summarizeExplorationGraph(graph: ExplorationGraph): string {
	const now = new Date();
	const nodesById = new Map(graph.nodes.map(node => [node.id, node]));

	const freshEdges = graph.edges
		.filter(edge => isEdgeFreshEnoughToSurface(edge, now))
		.sort((a, b) => b.verifiedCount - a.verifiedCount)
		.slice(0, MAX_SURFACED_EDGES);

	if (freshEdges.length === 0) {
		return 'No exploration graph recorded yet — nothing has been mapped from live browsing so far.';
	}

	const lines = freshEdges.map(edge => {
		const from = nodesById.get(edge.from);
		const to = nodesById.get(edge.to);
		const fromLabel = from?.label || from?.url || edge.from;
		const toLabel = to?.label || to?.url || edge.to;
		const actionText = edge.action.value
			? `${edge.action.type} "${edge.action.selector}" = "${edge.action.value}"`
			: `${edge.action.type}${
					edge.action.selector ? ` "${edge.action.selector}"` : ''
			  }`;

		return `${fromLabel} --${actionText}--> ${toLabel} (verified ${
			edge.verifiedCount
		}x, last ${new Date(edge.lastConfirmedAt).toLocaleDateString()})`;
	});

	return lines.join('\n');
}
