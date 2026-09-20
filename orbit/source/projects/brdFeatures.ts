import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import {getOrbitDir} from '../init/orbitDir.js';
import {checksumFromContent} from './checksum.js';
import {readFeatureClassifications} from './featureClassification.js';
import {
	extractBrdFeatures,
	type BrdFeature,
	type BrdFeaturePriority,
} from '../ai/extractBrdFeatures.js';
import type {ResponsesClient} from '../ai/client.js';

// .docx is a zip of XML, not text — reading it with fs.readFileSync's utf8
// mode returns binary/XML noise, not the document's actual words. mammoth
// is pure JS (no external binary like pandoc/LibreOffice needed), so this
// works the same on any machine Orbit itself runs on, not just one with
// office tooling installed. Anything else (.md, .txt, or no extension at
// all) is read as plain text, unchanged from before.
async function readBrdContent(brdPath: string): Promise<string> {
	if (path.extname(brdPath).toLowerCase() === '.docx') {
		const result = await mammoth.extractRawText({path: brdPath});
		return result.value;
	}

	return fs.readFileSync(brdPath, 'utf8');
}

export type BrdFeaturesFile = {
	version: 1;
	sourceChecksum: string;
	extractedAt: string;
	features: BrdFeature[];
};

function getBrdFeaturesPath(projectRoot: string): string {
	return path.join(getOrbitDir(projectRoot), 'index', 'brd-features.json');
}

export function readBrdFeatures(projectRoot: string): BrdFeaturesFile | null {
	const filePath = getBrdFeaturesPath(projectRoot);

	if (!fs.existsSync(filePath)) {
		return null;
	}

	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8')) as BrdFeaturesFile;
	} catch {
		return null;
	}
}

function writeBrdFeatures(projectRoot: string, data: BrdFeaturesFile): void {
	const filePath = getBrdFeaturesPath(projectRoot);
	fs.mkdirSync(path.dirname(filePath), {recursive: true});
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export type RefreshBrdFeaturesResult =
	| {ok: true; data: BrdFeaturesFile; refreshed: boolean}
	| {ok: false; error: string};

// Checksum-gated, same shape as getFreshClassification/scanProject's own
// mtime-skip logic — re-extraction only runs when the BRD's content has
// actually changed since the last time this ran, not on every /test call.
// Never throws: a missing/unreadable file or a failed extraction call comes
// back as {ok: false}, for the caller to treat as non-fatal (same reasoning
// the pre-test project scan already treats its own failure as non-blocking)
// rather than aborting the whole /test run over it.
export async function refreshBrdFeaturesIfNeeded(
	projectRoot: string,
	brdPath: string,
	model: string,
	client?: ResponsesClient,
	signal?: AbortSignal,
): Promise<RefreshBrdFeaturesResult> {
	let content: string;
	try {
		content = await readBrdContent(brdPath);
	} catch (error) {
		return {
			ok: false,
			error: `Could not read BRD at ${brdPath}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	const currentChecksum = checksumFromContent(content);
	const existing = readBrdFeatures(projectRoot);

	if (existing && existing.sourceChecksum === currentChecksum) {
		return {ok: true, data: existing, refreshed: false};
	}

	let extraction;
	try {
		extraction = await extractBrdFeatures(content, model, client, signal);
	} catch (error) {
		return {
			ok: false,
			error: `BRD extraction failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	const data: BrdFeaturesFile = {
		version: 1,
		sourceChecksum: currentChecksum,
		extractedAt: new Date().toISOString(),
		features: extraction.features,
	};
	writeBrdFeatures(projectRoot, data);

	return {ok: true, data, refreshed: true};
}

const PRIORITY_RANK: Record<BrdFeaturePriority, number> = {
	must: 0,
	should: 1,
	could: 2,
	// Sorts last, deliberately — see the design discussion this followed:
	// a requirement whose priority genuinely wasn't stated shouldn't be
	// silently pushed ahead of ones explicitly marked should/could, but it
	// also shouldn't rank alongside them with no signal either way. Last
	// is the honest position for "lowest confidence," not "unimportant."
	unspecified: 3,
};

export function sortByPriority(features: BrdFeature[]): BrdFeature[] {
	return [...features].sort(
		(a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
	);
}

// A feature is "covered" the same way coverage.ts already treats
// code-derived features: some test file declares it via write_test_file's
// own features argument, recorded into the same feature-classification.json
// every read_file classification also lives in (see recordClassification's
// callers). This works identically in blind mode, unlike coverage.ts's own
// route/component-based total, since it only ever looks at what tests
// declared — never at a structural project map that blind mode never has.
//
// Deliberately informational only — this used to filter already-covered
// features out of the BRD batch entirely, but Orbit has no way to know
// whether the underlying app changed since that test was last written (no
// git access, and in blind mode no source access at all), so a name match
// here is not evidence the feature still behaves the same way. Silently
// skipping on it would just be guessing that nothing changed. The caller
// re-tests every feature every run and uses this only to tell the user
// which ones are re-tests of an existing file versus genuinely new — never
// to decide what to run. Also deliberately does not check whether the
// covering file still exists or its checksum still matches: a feature that
// was covered by a file someone (or a reset) later deleted should still
// show as "previously covered by X", not silently look brand new.
export function getFeatureCoverage(
	projectRoot: string,
	testDir: string,
): Map<string, string[]> {
	const classifications = readFeatureClassifications(projectRoot);
	const normalizedTestDir = testDir.endsWith(path.sep)
		? testDir
		: testDir + path.sep;

	const coverage = new Map<string, string[]>();
	for (const [relativeFile, entry] of Object.entries(
		classifications.entries,
	)) {
		const isTestFile =
			relativeFile === testDir || relativeFile.startsWith(normalizedTestDir);
		if (!isTestFile) continue;
		for (const feature of entry.features) {
			const files = coverage.get(feature) ?? [];
			files.push(relativeFile);
			coverage.set(feature, files);
		}
	}

	return coverage;
}
