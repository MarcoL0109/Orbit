import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {
	readEnvironmentSetupInstructions,
	writeEnvironmentSetupInstructions,
	invalidateEnvironmentSetupInstructions,
} from '../memory.js';

function makeTemporaryDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-memory-'));
}

test('invalidate deletes a previously written file', t => {
	const dir = makeTemporaryDir();
	writeEnvironmentSetupInstructions(dir, 'docker compose up -d');
	t.not(readEnvironmentSetupInstructions(dir), null);

	invalidateEnvironmentSetupInstructions(dir);

	t.is(readEnvironmentSetupInstructions(dir), null);
});

test('invalidate is a no-op when no file exists yet', t => {
	const dir = makeTemporaryDir();

	t.notThrows(() => {
		invalidateEnvironmentSetupInstructions(dir);
	});
	t.is(readEnvironmentSetupInstructions(dir), null);
});

test('invalidate is a no-op when the memory dir itself was never created', t => {
	const dir = makeTemporaryDir();
	const neverInitialized = path.join(dir, 'not-a-project');

	t.notThrows(() => {
		invalidateEnvironmentSetupInstructions(neverInitialized);
	});
});
