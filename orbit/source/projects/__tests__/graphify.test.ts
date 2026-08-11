import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {ensureGraphifyGitignored} from '../graphify.js';

// Only ensureGraphifyGitignored is covered here — isGraphifyAvailable,
// installGraphify, and runGraphifyScan all shell out to the real `graphify`
// binary with no injection seam, so a hermetic unit test can't exercise
// them without either invoking a real subprocess (slow, requires graphify
// installed, not reproducible in every environment) or adding mocking
// machinery this codebase doesn't otherwise use. Those stay covered by
// live/manual verification instead — same tradeoff as the browser worker.
function makeProjectRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-graphify-'));
}

test('does nothing when the project has no .gitignore at all', t => {
	const projectRoot = makeProjectRoot();

	ensureGraphifyGitignored(projectRoot);

	t.false(fs.existsSync(path.join(projectRoot, '.gitignore')));
});

test('appends graphify-out/ to an existing .gitignore', t => {
	const projectRoot = makeProjectRoot();
	fs.writeFileSync(
		path.join(projectRoot, '.gitignore'),
		'node_modules/\ndist/\n',
		'utf8',
	);

	ensureGraphifyGitignored(projectRoot);

	const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
	t.is(content, 'node_modules/\ndist/\ngraphify-out/\n');
});

test('does not duplicate the entry on a second run', t => {
	const projectRoot = makeProjectRoot();
	fs.writeFileSync(
		path.join(projectRoot, '.gitignore'),
		'node_modules/\ngraphify-out/\n',
		'utf8',
	);

	ensureGraphifyGitignored(projectRoot);

	const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
	t.is(content.match(/graphify-out/g)?.length, 1);
});

test('recognizes the entry even without a trailing slash', t => {
	const projectRoot = makeProjectRoot();
	fs.writeFileSync(
		path.join(projectRoot, '.gitignore'),
		'graphify-out\n',
		'utf8',
	);

	ensureGraphifyGitignored(projectRoot);

	const content = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
	t.is(content.match(/graphify-out/g)?.length, 1);
});
