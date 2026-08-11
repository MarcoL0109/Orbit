import type {ProjectMap, ProjectComponent} from './scan.js';
import {readChecksumsFile, type ChecksumsFile} from './checksum.js';
import {getFreshClassification} from './featureClassification.js';

export type CoverageStatus = 'covered' | 'loosely-covered' | 'uncovered';
export type AssessmentMethod = 'llm-verified' | 'heuristic-only';

// Every route/component gets an entry, not just the gaps — "covered" is a
// status like any other, not an absence of one, so it can be rendered
// (green) alongside loosely-covered (yellow) and uncovered (red).
export type CoverageEntry = {
	kind: 'route' | 'component';
	name: string;
	file: string;
	featureGuess: string;
	status: CoverageStatus;
	assessedBy: AssessmentMethod;
};

export type CoverageReport = {
	totalRoutes: number;
	routes: CoverageEntry[];

	totalAssessableComponents: number;
	components: CoverageEntry[];
	unassessableComponentCount: number;

	// How many routes/components have actually been read-and-classified by
	// the agent at least once, out of how many exist in total — the "how
	// much of this report is a black box" stat.
	llmVerifiedSubjectCount: number;
	totalSubjectCount: number;
};

function normalizeTag(value: string): string {
	return value.trim().toLowerCase();
}

function broadTagOf(tag: string): string {
	return normalizeTag(tag).split('.')[0]!;
}

function normalizeForSubstring(value: string): string {
	return value.toLowerCase().replace(/[^a-z\d]/g, '');
}

function routeSegments(route: string): string[] {
	return route
		.split('/')
		.filter(Boolean)
		.filter(segment => !segment.startsWith(':'));
}

type TestSignal = {
	llmFeatures: string[] | null;
	featureGuess: string | null;
	normalizedPath: string;
};

function getSubjectClassification(
	projectRoot: string,
	file: string,
	checksums: ChecksumsFile | null,
) {
	const checksum = checksums?.files[file]?.checksum;
	return checksum ? getFreshClassification(projectRoot, file, checksum) : null;
}

function collectTestSignals(
	projectMap: ProjectMap,
	projectRoot: string,
	checksums: ChecksumsFile | null,
): TestSignal[] {
	return projectMap.tests.map(test => {
		const classification = getSubjectClassification(
			projectRoot,
			test.file,
			checksums,
		);
		return {
			llmFeatures: classification?.features ?? null,
			featureGuess: test.featureGuess,
			normalizedPath: normalizeForSubstring(test.file),
		};
	});
}

// A test with an LLM classification that shares an exact feature tag with
// the subject — the strongest signal available.
function hasExactTagMatch(subjectTags: string[], tests: TestSignal[]): boolean {
	const subjectExact = new Set(subjectTags.map(normalizeTag));
	return tests.some(
		test =>
			test.llmFeatures?.some(tag => subjectExact.has(normalizeTag(tag))) ??
			false,
	);
}

// A test (LLM-classified or heuristic-guessed) that shares the subject's
// broad/top-level feature, without matching the specific sub-feature.
function hasBroadTagMatch(
	subjectBroadTags: Set<string>,
	tests: TestSignal[],
): boolean {
	return tests.some(test => {
		if (test.llmFeatures) {
			return test.llmFeatures.some(tag =>
				subjectBroadTags.has(broadTagOf(tag)),
			);
		}

		return (
			test.featureGuess !== null &&
			subjectBroadTags.has(normalizeTag(test.featureGuess))
		);
	});
}

// Heuristic fallback: does any test's *filename* contain every identifying
// segment (route path segments, or the component name)?
function hasFilenameSegmentMatch(
	normalizedSegments: string[],
	tests: TestSignal[],
): boolean {
	if (normalizedSegments.length === 0) return false;
	return tests.some(test =>
		normalizedSegments.every(segment => test.normalizedPath.includes(segment)),
	);
}

// Same idea, but searching a classified test's *feature tags* instead of
// its filename. This is what makes a grouped test file work — a file
// covering both checkout.payment and checkout.shipping gets classified
// with both tags, and this lets each route match against that combined
// tag text even though the SUBJECT itself (the route) was never read and
// has no classification of its own. Without this, a subject with no
// classification only ever got compared against test filenames, silently
// ignoring any LLM tag data sitting on the test side.
function hasClassifiedTagSegmentMatch(
	normalizedSegments: string[],
	tests: TestSignal[],
): boolean {
	if (normalizedSegments.length === 0) return false;
	return tests.some(test => {
		if (!test.llmFeatures || test.llmFeatures.length === 0) return false;
		const tagBlob = normalizeForSubstring(test.llmFeatures.join(' '));
		return normalizedSegments.every(segment => tagBlob.includes(segment));
	});
}

function assess(
	llmFeatures: string[] | null,
	featureGuess: string,
	segments: string[],
	tests: TestSignal[],
): {status: CoverageStatus; assessedBy: AssessmentMethod} {
	if (llmFeatures && llmFeatures.length > 0) {
		if (hasExactTagMatch(llmFeatures, tests)) {
			return {status: 'covered', assessedBy: 'llm-verified'};
		}

		const broadTags = new Set(llmFeatures.map(broadTagOf));
		return hasBroadTagMatch(broadTags, tests)
			? {status: 'loosely-covered', assessedBy: 'llm-verified'}
			: {status: 'uncovered', assessedBy: 'llm-verified'};
	}

	const normalizedSegments = segments
		.map(normalizeForSubstring)
		.filter(Boolean);

	// Subject itself was never classified — still worth checking whether a
	// classified test's tags specifically reference it before falling back
	// to filename/bucket heuristics alone.
	if (hasClassifiedTagSegmentMatch(normalizedSegments, tests)) {
		return {status: 'covered', assessedBy: 'llm-verified'};
	}

	if (hasFilenameSegmentMatch(normalizedSegments, tests)) {
		return {status: 'covered', assessedBy: 'heuristic-only'};
	}

	const broadTags = new Set([normalizeTag(featureGuess)]);
	return hasBroadTagMatch(broadTags, tests)
		? {status: 'loosely-covered', assessedBy: 'heuristic-only'}
		: {status: 'uncovered', assessedBy: 'heuristic-only'};
}

export function computeCoverage(
	projectMap: ProjectMap,
	projectRoot: string,
): CoverageReport {
	const checksums = readChecksumsFile(projectRoot);
	const testSignals = collectTestSignals(projectMap, projectRoot, checksums);
	let llmVerifiedSubjectCount = 0;

	const routes: CoverageEntry[] = [];

	for (const route of projectMap.routes) {
		const classification = getSubjectClassification(
			projectRoot,
			route.file,
			checksums,
		);
		if (classification) llmVerifiedSubjectCount++;

		const {status, assessedBy} = assess(
			classification?.features ?? null,
			route.featureGuess,
			routeSegments(route.route),
			testSignals,
		);

		routes.push({
			kind: 'route',
			name: route.route,
			file: route.file,
			featureGuess: route.featureGuess,
			status,
			assessedBy,
		});
	}

	const assessableComponents = projectMap.components.filter(
		(component): component is ProjectComponent & {featureGuess: string} =>
			component.featureGuess !== null,
	);

	const components: CoverageEntry[] = [];

	for (const component of assessableComponents) {
		const classification = getSubjectClassification(
			projectRoot,
			component.file,
			checksums,
		);
		if (classification) llmVerifiedSubjectCount++;

		const {status, assessedBy} = assess(
			classification?.features ?? null,
			component.featureGuess,
			[component.name],
			testSignals,
		);

		components.push({
			kind: 'component',
			name: component.name,
			file: component.file,
			featureGuess: component.featureGuess,
			status,
			assessedBy,
		});
	}

	return {
		totalRoutes: projectMap.routes.length,
		routes,

		totalAssessableComponents: assessableComponents.length,
		components,
		unassessableComponentCount:
			projectMap.components.length - assessableComponents.length,

		llmVerifiedSubjectCount,
		totalSubjectCount: projectMap.routes.length + assessableComponents.length,
	};
}

const STATUS_ICON: Record<CoverageStatus, string> = {
	covered: '✓',
	'loosely-covered': '~',
	uncovered: '✗',
};

export function colorForCoverageStatus(
	status: CoverageStatus,
): 'green' | 'yellow' | 'red' {
	if (status === 'covered') return 'green';
	if (status === 'loosely-covered') return 'yellow';
	return 'red';
}

export function describeCoverageEntry(entry: CoverageEntry): string {
	const confidence =
		entry.assessedBy === 'llm-verified' ? '[verified]' : '[heuristic]';
	const header = `${STATUS_ICON[entry.status]} ${confidence} ${entry.name} (${
		entry.file
	})`;

	if (entry.status === 'covered') {
		return header;
	}

	const note =
		entry.status === 'loosely-covered'
			? `something in "${entry.featureGuess}" is tested, but nothing specifically targets this`
			: 'no related test found';

	return `${header} — ${note}`;
}

export function formatCoverageSummary(report: CoverageReport): string {
	const coveredRoutes = report.routes.filter(
		entry => entry.status === 'covered',
	).length;
	const coveredComponents = report.components.filter(
		entry => entry.status === 'covered',
	).length;

	return `Coverage summary (based on the last /scan, refined by any files the agent has read during /test runs):

Confidence: ${report.llmVerifiedSubjectCount}/${report.totalSubjectCount} routes/components have been content-verified by the agent; the rest rely on filename/heuristic guessing only.

Routes: ${coveredRoutes}/${report.totalRoutes} specifically covered
Components: ${coveredComponents}/${report.totalAssessableComponents} specifically covered (${report.unassessableComponentCount} more couldn't be matched to a feature and aren't counted either way)

How this is judged: covered (green) means a test targets this specifically (verified: matching feature tags from actual file content; heuristic: the route/component's path or name appears in a test's filename). loosely-covered (yellow) means no test targets it specifically, but something in the same broad feature area is tested. uncovered (red) means nothing related was found. [heuristic] entries are filename-based guesses, not confirmed by content — treat them as leads, not facts.`;
}
