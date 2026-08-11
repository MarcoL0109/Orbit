import fs from 'node:fs';
import path from 'node:path';
import {checksumFromContent} from '../../projects/checksum.js';
import {recordClassification} from '../../projects/featureClassification.js';
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
		const testDirAbsolute = path.resolve(
			context.projectRoot,
			context.orbitConfig.testDir,
		);
		const testDirWithSep = testDirAbsolute.endsWith(path.sep)
			? testDirAbsolute
			: testDirAbsolute + path.sep;
		const resolved = path.resolve(testDirAbsolute, relativePath);

		if (resolved !== testDirAbsolute && !resolved.startsWith(testDirWithSep)) {
			return {ok: false, error: 'Path escapes the configured test directory'};
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
