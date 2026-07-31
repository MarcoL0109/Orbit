import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { walkProjectFiles } from './path.js';


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


export function computeFileChecksum(filePath: string) {
    const content = fs.readFileSync(filePath);

    return crypto
    .createHash('sha256')
    .update(content)
    .digest('hex');
}


export function buildChecksumsFile(projectRoot: string, files: Array<{file: string;}>): ChecksumsFile {
    const now = new Date().toISOString();
    const entries: Record<string, FileChecksumEntry> = {};

    for (const file of files) {
        const absolutePath = path.join(projectRoot, file.file);
        const stats = fs.statSync(absolutePath);

        entries[file.file] = {
            checksum: computeFileChecksum(absolutePath),
            sizeBytes: stats.size,
            modifiedAt: stats.mtime.toISOString(),
            scannedAt: now,
        };
    }

    return {
        version: 1,
        generatedAt: now,
        algorithm: 'sha256',
        files: entries,
    };
}


export function compareChecksums(oldChecksums: ChecksumsFile | null, newChecksums: ChecksumsFile): ChecksumDiff {
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
        if (!oldFiles[file]) {
            added.push(file);
            continue;
        }
        if (oldFiles[file].checksum !== newFiles[file].checksum) {
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


export function writeChecksumFile(projectRoot: string) {
    const files = walkProjectFiles(projectRoot);
    const checksumFiles = files.map((file) => ({ file }));
    const checksum = buildChecksumsFile(projectRoot, checksumFiles);
    const indexDir = path.join(projectRoot, '.orbit', 'index');
      
    fs.mkdirSync(indexDir, {
        recursive: true,
    });

    const checksumsJsonPath = path.join(indexDir, 'checksums.json');
    fs.writeFileSync(checksumsJsonPath, JSON.stringify(checksum, null, 2), 'utf8');
    return checksumsJsonPath;
}