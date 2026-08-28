import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {getOrbitDir} from '../init/orbitDir.js';

export type ChecksumsFile = {
	version: 1;
	generatedAt: string;
	algorithm: 'sha256';
	files: Record<string, FileChecksumEntry>;
};

export type ChecksumDiff = {
	added: string[];
	changed: string[];
	unchanged: string[];
	deleted: string[];
};

export type FileChecksumEntry = {
	checksum: string;
	sizeBytes: number;
	modifiedAt: string;
	scannedAt: string;
};

export function checksumFromContent(
	content: string | NodeJS.ArrayBufferView,
): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

export function computeFileChecksum(filePath: string) {
	return checksumFromContent(fs.readFileSync(filePath));
}

export function buildChecksumsFile(
	entries: Record<string, FileChecksumEntry>,
): ChecksumsFile {
	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		algorithm: 'sha256',
		files: entries,
	};
}

export function compareChecksums(
	oldChecksums: ChecksumsFile | null,
	newChecksums: ChecksumsFile,
): ChecksumDiff {
	if (!oldChecksums) {
		return {
			added: Object.keys(newChecksums.files),
			changed: [],
			unchanged: [],
			deleted: [],
		};
	}

	const oldFiles = oldChecksums.files;
	const newFiles = newChecksums.files;

	const added: string[] = [];
	const changed: string[] = [];
	const unchanged: string[] = [];
	const deleted: string[] = [];

	for (const file of Object.keys(newFiles)) {
		const oldEntry = oldFiles[file];
		const newEntry = newFiles[file]!;

		if (!oldEntry) {
			added.push(file);
			continue;
		}

		if (oldEntry.checksum !== newEntry.checksum) {
			changed.push(file);
			continue;
		}

		unchanged.push(file);
	}

	for (const file of Object.keys(oldFiles)) {
		if (!newFiles[file]) {
			deleted.push(file);
		}
	}

	return {
		added,
		changed,
		unchanged,
		deleted,
	};
}

function getChecksumsJsonPath(projectRoot: string) {
	return path.join(getOrbitDir(projectRoot), 'index', 'checksums.json');
}

export function readChecksumsFile(projectRoot: string): ChecksumsFile | null {
	const checksumsJsonPath = getChecksumsJsonPath(projectRoot);

	if (!fs.existsSync(checksumsJsonPath)) {
		return null;
	}

	try {
		return JSON.parse(
			fs.readFileSync(checksumsJsonPath, 'utf8'),
		) as ChecksumsFile;
	} catch {
		return null;
	}
}

export function writeChecksumsFile(
	projectRoot: string,
	checksums: ChecksumsFile,
) {
	const checksumsJsonPath = getChecksumsJsonPath(projectRoot);

	fs.mkdirSync(path.dirname(checksumsJsonPath), {recursive: true});
	fs.writeFileSync(
		checksumsJsonPath,
		JSON.stringify(checksums, null, 2),
		'utf8',
	);
	return checksumsJsonPath;
}
