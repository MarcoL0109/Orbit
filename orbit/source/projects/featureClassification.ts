import fs from 'node:fs';
import path from 'node:path';
import {getOrbitDir} from '../init/orbitDir.js';

export type FeatureClassificationEntry = {
	checksum: string;
	features: string[];
	classifiedAt: string;
	// True only for a test whose own subject IS login/session/authentication
	// itself — everything else should run pre-authenticated via the shared
	// storageState (see writeAuthSetup.ts, runTest.ts). Optional/undefined
	// for every entry written before this existed and for source-file
	// classifications (which were never about session state at all); both
	// are treated as false. See run_test's own handling of this flag.
	requiresFreshSession?: boolean;
};

export type FeatureClassificationFile = {
	version: 1;
	entries: Record<string, FeatureClassificationEntry>;
};

function getFeatureClassificationPath(projectRoot: string): string {
	return path.join(
		getOrbitDir(projectRoot),
		'index',
		'feature-classification.json',
	);
}

export function readFeatureClassifications(
	projectRoot: string,
): FeatureClassificationFile {
	const filePath = getFeatureClassificationPath(projectRoot);

	if (!fs.existsSync(filePath)) {
		return {version: 1, entries: {}};
	}

	try {
		return JSON.parse(
			fs.readFileSync(filePath, 'utf8'),
		) as FeatureClassificationFile;
	} catch {
		return {version: 1, entries: {}};
	}
}

function writeFeatureClassifications(
	projectRoot: string,
	data: FeatureClassificationFile,
): void {
	const filePath = getFeatureClassificationPath(projectRoot);
	fs.mkdirSync(path.dirname(filePath), {recursive: true});
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Returns the cached entry only if it's still fresh (checksum matches the
// file's current state) — a stale entry (file changed since classified) is
// treated the same as no entry at all, not returned.
export function getFreshClassification(
	projectRoot: string,
	relativeFile: string,
	currentChecksum: string,
): FeatureClassificationEntry | null {
	const entry = readFeatureClassifications(projectRoot).entries[relativeFile];
	return entry && entry.checksum === currentChecksum ? entry : null;
}

export function recordClassification(
	projectRoot: string,
	relativeFile: string,
	checksum: string,
	features: string[],
	requiresFreshSession = false,
): void {
	const data = readFeatureClassifications(projectRoot);
	data.entries[relativeFile] = {
		checksum,
		features,
		classifiedAt: new Date().toISOString(),
		requiresFreshSession,
	};
	writeFeatureClassifications(projectRoot, data);
}
