import fs from 'node:fs';
import path from 'node:path';
import {checksumFromContent} from '../../projects/checksum.js';
import {recordClassification} from '../../projects/featureClassification.js';
import {resolveConfiguredDir} from '../../init/config.js';
import {findUnverifiedNames} from '../verifiedSelectors.js';
import type {ToolDefinition} from './types.js';

type WriteTestFileArgs = {
	relativePath: string;
	content: string;
	features: string[];
};

type WriteTestFileData = {
	path: string;
};

export const writeTestFileTool: ToolDefinition<
	WriteTestFileArgs,
	WriteTestFileData
> = {
	name: 'write_test_file',
	description:
		'Write a Playwright test file. The path is relative to the configured test directory — it cannot write anywhere else in the project.',
	parameters: {
		type: 'object',
		properties: {
			relativePath: {
				type: 'string',
				description:
					'Path relative to the configured test directory, e.g. "login.spec.ts"',
			},
			content: {
				type: 'string',
				description: 'The full contents of the test file',
			},
			features: {
				type: 'array',
				items: {type: 'string'},
				description:
					'The feature(s) this test file covers, using short lowercase dot-separated names (e.g. ["checkout.payment", "checkout.shipping"]) — you already know this, since you\'re the one writing it. List every sub-feature if this file groups more than one. Used for coverage tracking.',
			},
		},
		required: ['relativePath', 'content', 'features'],
	},
	async execute({relativePath, content, features}, context) {
		const testDirResolution = resolveConfiguredDir(
			context.projectRoot,
			context.orbitConfig.testDir,
			'testDir',
		);
		if (!testDirResolution.ok) {
			return {ok: false, error: testDirResolution.error};
		}

		const testDirAbsolute = testDirResolution.path;
		const relativePathResolution = resolveConfiguredDir(
			testDirAbsolute,
			relativePath,
			'relativePath',
		);
		if (!relativePathResolution.ok) {
			return {ok: false, error: relativePathResolution.error};
		}

		const resolved = relativePathResolution.path;

		// Blind mode has no source to fall back on — a selector here can
		// only ever be legitimate if it traces back to something actually
		// clicked/filled live via browser_action this run, never memory of
		// a past run, the exploration graph's own "hint, not ground truth"
		// summary, or general assumptions about how this kind of app
		// usually works. Confirmed directly: a real run wrote and ran a
		// test with zero browser_action calls at all this run, reusing
		// selectors from something other than this run's own exploration.
		// Advisory guidance alone (summarizeVerifiedSelectors, surfaced in
		// the prompt every turn) didn't stop that; this does, mechanically.
		if (context.orbitConfig.blind) {
			const unverifiedNames = findUnverifiedNames(content, context.getSteps());
			if (unverifiedNames.length > 0) {
				return {
					ok: false,
					error: `This blind project has no source to fall back on, so every interactive element this test references must trace back to something you actually clicked or filled live via browser_action this run — not a past run, the exploration graph's own summary, or a general assumption about how this kind of app usually works. No verified action this run matches: ${unverifiedNames
						.map(name => `"${name}"`)
						.join(
							', ',
						)}. Go verify each of these live with browser_action, then call write_test_file again.`,
				};
			}
		}

		if (context.orbitConfig.writeMode === 'ask') {
			const approved = await context.requestApproval(
				`Write test file: ${path.relative(context.projectRoot, resolved)}`,
			);
			if (!approved) {
				return {ok: false, error: 'User declined the write'};
			}
		}

		try {
			fs.mkdirSync(path.dirname(resolved), {recursive: true});
			fs.writeFileSync(resolved, content, 'utf8');
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		// Record the agent's own declared features directly — no
		// classification call needed here. The agent already knows what
		// it's writing and why; re-deriving that from content after the
		// fact (like read_file does for files it's only inspecting) would
		// just be an extra API round-trip to confirm something already
		// known, and would re-fire on every repair retry since the
		// checksum changes each time even though the intent doesn't.
		recordClassification(
			context.projectRoot,
			path.relative(context.projectRoot, resolved),
			checksumFromContent(content),
			features,
		);

		return {ok: true, data: {path: resolved}};
	},
};
