import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {detectProjectAtPath} from '../search.js';

function makeTemporaryDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-search-'));
}

test('trusts an explicit directory as the root even with no markers at all', t => {
	const dir = makeTemporaryDir();

	const result = detectProjectAtPath(dir);

	t.true(result.isProject);
	t.is(result.root, dir);
	t.is(result.confidence, 0);
});

test('picks up framework/package-manager markers from the explicit directory', t => {
	const dir = makeTemporaryDir();
	fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8');
	fs.writeFileSync(path.join(dir, 'next.config.js'), '', 'utf8');
	fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}', 'utf8');

	const result = detectProjectAtPath(dir);

	t.true(result.isProject);
	t.is(result.root, dir);
	t.is(result.framework, 'Next.js');
	t.is(result.packageManager, 'npm');
});

test('never walks up to a parent directory looking for markers', t => {
	const parent = makeTemporaryDir();
	fs.writeFileSync(path.join(parent, 'package.json'), '{}', 'utf8');
	const child = path.join(parent, 'subdir-with-nothing');
	fs.mkdirSync(child);

	const result = detectProjectAtPath(child);

	t.true(result.isProject);
	t.is(result.root, child);
	t.deepEqual(result.markers, []);
});

test('reports .orbit already present via hasOrbitFolder', t => {
	const dir = makeTemporaryDir();
	fs.mkdirSync(path.join(dir, '.orbit'));

	const result = detectProjectAtPath(dir);

	t.true(result.hasOrbitFolder);
});

test('rejects a path that does not exist', t => {
	const result = detectProjectAtPath(
		path.join(os.tmpdir(), 'orbit-search-does-not-exist-xyz'),
	);

	t.false(result.isProject);
	t.is(result.root, null);
});

test('rejects a path that is a file, not a directory', t => {
	const dir = makeTemporaryDir();
	const filePath = path.join(dir, 'not-a-dir.txt');
	fs.writeFileSync(filePath, 'hi', 'utf8');

	const result = detectProjectAtPath(filePath);

	t.false(result.isProject);
	t.is(result.root, null);
});
