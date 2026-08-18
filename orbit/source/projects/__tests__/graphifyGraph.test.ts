import test from 'ava';
import {
	findGraphNodes,
	type GraphifyGraph,
	type GraphifyNode,
} from '../graphifyGraph.js';

// Mirrors the real shape graphify writes (confirmed against a live
// graph.json from a Next.js App Router project): a file's own module-level
// node has a label matching its (prefix-stripped) path, while every
// function/component inside it gets its own "Name()"-shaped label, all
// sharing the same source_file. graphify strips a leading path segment
// inconsistently — the project root's own file kept its "app/" prefix in
// its label, everything else lost it — which is exactly the mismatch
// findGraphNodes' path-based tiers exist to route around without hardcoding
// any one framework's directory convention.
function node(
	overrides: Partial<GraphifyNode> &
		Pick<GraphifyNode, 'label' | 'source_file'>,
): GraphifyNode {
	return {
		file_type: 'code',
		source_location: 'L1',
		id: `${overrides.source_file}#${overrides.label}`,
		norm_label: overrides.label.toLowerCase(),
		...overrides,
	};
}

function graphFixture(): GraphifyGraph {
	return {
		nodes: [
			node({label: 'contacts/page.tsx', source_file: 'app/contacts/page.tsx'}),
			node({label: 'ContactsPage()', source_file: 'app/contacts/page.tsx'}),
			node({label: 'onDeleteSelected()', source_file: 'app/contacts/page.tsx'}),
			node({label: 'app/page.tsx', source_file: 'app/page.tsx'}),
			node({label: 'Launcher()', source_file: 'app/page.tsx'}),
			// A second, unrelated route that also happens to end in
			// "page.tsx" — exercises the genuinely-ambiguous-by-basename case.
			node({label: 'sales/page.tsx', source_file: 'app/sales/page.tsx'}),
		],
		links: [],
	};
}

test('exact label match still wins first, unaffected by the new path tiers', t => {
	const graph = graphFixture();
	const matches = findGraphNodes(graph, 'Launcher()');
	t.is(matches.length, 1);
	t.is(matches[0]!.label, 'Launcher()');
});

test('the model\'s real path (with the "app/" prefix graphify\'s label dropped) finds the file node directly', t => {
	const graph = graphFixture();
	const matches = findGraphNodes(graph, 'app/contacts/page.tsx');
	t.is(matches.length, 1);
	t.is(matches[0]!.label, 'contacts/page.tsx');
});

test('a path exact-match on a file that kept its prefix in the label also resolves to one node', t => {
	const graph = graphFixture();
	const matches = findGraphNodes(graph, 'app/page.tsx');
	t.is(matches.length, 1);
	t.is(matches[0]!.label, 'app/page.tsx');
});

test('a shorter suffix of the real path still finds the file node, not its functions', t => {
	const graph = graphFixture();
	const matches = findGraphNodes(graph, 'contacts/page.tsx');
	t.is(matches.length, 1);
	t.is(matches[0]!.label, 'contacts/page.tsx');
});

test('a bare filename shared by several different routes stays genuinely ambiguous', t => {
	const graph = graphFixture();
	const matches = findGraphNodes(graph, 'page.tsx');
	// Every file in the fixture ends in page.tsx — this must not silently
	// pick one; preferFileLevelNode only narrows within a single
	// source_file, never across different ones.
	const distinctFiles = new Set(matches.map(m => m.source_file));
	t.true(distinctFiles.size > 1);
});

test('a path match with no distinct non-callable node returns every candidate rather than guessing', t => {
	const graph: GraphifyGraph = {
		nodes: [
			node({label: 'a()', source_file: 'app/weird/page.tsx'}),
			node({label: 'b()', source_file: 'app/weird/page.tsx'}),
		],
		links: [],
	};
	const matches = findGraphNodes(graph, 'app/weird/page.tsx');
	t.is(matches.length, 2);
});

test('a same-file constant does not defeat narrowing to the file node — it also lacks "()" but is not path-shaped', t => {
	const graph: GraphifyGraph = {
		nodes: [
			node({label: 'workflow/page.tsx', source_file: 'app/workflow/page.tsx'}),
			node({label: 'Workflow()', source_file: 'app/workflow/page.tsx'}),
			// A module-level constant: no "()", but also no file extension —
			// a naive "not callable" filter would wrongly keep this alongside
			// the real file node, reintroducing the ambiguity this narrowing
			// exists to avoid.
			node({label: 'SUGGESTIONS', source_file: 'app/workflow/page.tsx'}),
		],
		links: [],
	};
	const matches = findGraphNodes(graph, 'app/workflow/page.tsx');
	t.is(matches.length, 1);
	t.is(matches[0]!.label, 'workflow/page.tsx');
});

test('still falls through to the loose substring tier when nothing path-shaped matches', t => {
	const graph = graphFixture();
	const matches = findGraphNodes(graph, 'contacts');
	t.true(matches.length > 0);
	t.true(matches.every(m => m.norm_label.includes('contacts')));
});
