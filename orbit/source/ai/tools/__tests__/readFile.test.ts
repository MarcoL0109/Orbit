import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'ava';
import {readFileTool} from '../readFile.js';

function makeProjectRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-read-file-'));
}

function fakeContext(projectRoot: string) {
	return {projectRoot, signal: new AbortController().signal};
}

for (const blocked of [
	'.env',
	'.env.local',
	'.env.production',
	'.env.development',
]) {
	test(`refuses to read ${blocked}`, async t => {
		const projectRoot = makeProjectRoot();
		fs.writeFileSync(path.join(projectRoot, blocked), 'SECRET=shh', 'utf8');

		const result = await readFileTool.execute(
			{path: blocked},
			fakeContext(projectRoot),
		);

		t.false(result.ok);
		if (!result.ok) {
			t.regex(result.error, /never reads \.env/);
		}
	});
}

test('refuses to read a nested .env (e.g. backend/.env)', async t => {
	const projectRoot = makeProjectRoot();
	fs.mkdirSync(path.join(projectRoot, 'backend'));
	fs.writeFileSync(
		path.join(projectRoot, 'backend', '.env'),
		'SECRET=shh',
		'utf8',
	);

	const result = await readFileTool.execute(
		{path: 'backend/.env'},
		fakeContext(projectRoot),
	);

	t.false(result.ok);
});

for (const allowed of [
	'.env.example',
	'.env.sample',
	'.env.template',
	'.env.dist',
]) {
	test(`still allows reading ${allowed} (template, no real secrets)`, async t => {
		const projectRoot = makeProjectRoot();
		fs.writeFileSync(path.join(projectRoot, allowed), 'SECRET=', 'utf8');

		const result = await readFileTool.execute(
			{path: allowed},
			fakeContext(projectRoot),
		);

		t.true(result.ok);
		if (result.ok) {
			t.is(result.data.content, 'SECRET=');
		}
	});
}

for (const notAnEnvFile of ['.environment', '.envrc', 'environment.ts']) {
	test(`does not mistake ${notAnEnvFile} for an env file`, async t => {
		const projectRoot = makeProjectRoot();
		fs.writeFileSync(path.join(projectRoot, notAnEnvFile), 'hello', 'utf8');

		const result = await readFileTool.execute(
			{path: notAnEnvFile},
			fakeContext(projectRoot),
		);

		t.true(result.ok);
	});
}
