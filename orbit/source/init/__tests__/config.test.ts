import test from 'ava';
import {resolveConfiguredDir} from '../config.js';

test('resolves a normal relative subdirectory', t => {
	const result = resolveConfiguredDir(
		'/repo/frontend',
		'Orbit-test/e2e',
		'testDir',
	);

	t.true(result.ok);
	t.is(result.ok && result.path, '/repo/frontend/Orbit-test/e2e');
});

test('resolves projectRoot itself (empty-ish configured dir)', t => {
	const result = resolveConfiguredDir('/repo/frontend', '.', 'testDir');

	t.true(result.ok);
	t.is(result.ok && result.path, '/repo/frontend');
});

test('rejects a configured dir that walks out of projectRoot via ../..', t => {
	const result = resolveConfiguredDir('/repo/frontend', '../../etc', 'testDir');

	t.false(result.ok);
	t.true(!result.ok && result.error.includes('testDir'));
});

test('rejects an absolute path elsewhere on disk', t => {
	const result = resolveConfiguredDir(
		'/repo/frontend',
		'/etc/passwd',
		'testDir',
	);

	t.false(result.ok);
});

test('rejects a sibling directory that merely shares a name prefix', t => {
	// /repo/frontend-evil is NOT inside /repo/frontend even though the
	// string "/repo/frontend" is a prefix of it — a naive startsWith check
	// without the trailing separator would wrongly allow this.
	const result = resolveConfiguredDir(
		'/repo/frontend',
		'../frontend-evil',
		'testDir',
	);

	t.false(result.ok);
});

test('error message names the offending field', t => {
	const result = resolveConfiguredDir(
		'/repo/frontend',
		'../escape',
		'manualTestDir',
	);

	t.false(result.ok);
	t.true(!result.ok && result.error.includes('manualTestDir'));
});
