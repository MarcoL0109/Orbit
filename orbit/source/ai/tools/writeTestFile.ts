import fs from 'node:fs';
import path from 'node:path';
import {checksumFromContent} from '../../projects/checksum.js';
import {recordClassification} from '../../projects/featureClassification.js';
import {resolveConfiguredDir} from '../../init/config.js';
import {findUnverifiedNames} from '../verifiedSelectors.js';
import {findFragileCountAssertions} from './fragileAssertions.js';
import type {ToolDefinition} from './types.js';

type WriteTestFileArgs = {
	relativePath: string;
	content: string;
	features: string[];
	requiresFreshSession: boolean;
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
			requiresFreshSession: {
				type: 'boolean',
				description:
					'true only if this test\'s own subject is login/authentication/session behavior itself (e.g. verifying login succeeds or fails, session expiry, logout) — almost always false. When true, run_test skips the shared pre-authenticated storageState for this file and lets it start from a genuinely fresh, logged-out browser, so it actually exercises what it claims to test rather than starting already signed in. Every other feature (creating, editing, searching, anything that merely NEEDS to be logged in to run) should be false and rely on the shared authenticated session instead of writing its own login steps.',
			},
		},
		required: ['relativePath', 'content', 'features', 'requiresFreshSession'],
	},
	async execute(
		{relativePath, content, features, requiresFreshSession},
		context,
	) {
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

		// Applies in every mode, not just blind — this isn't about missing
		// source to verify against, it's about a specific mistake the model
		// makes regardless of how much project context it has (see
		// fragileAssertions.ts).
		const fragileAssertions = findFragileCountAssertions(content);
		if (fragileAssertions.length > 0) {
			return {
				ok: false,
				error: `This test contains an assertion that treats shared, mutable backend data as a fixed fact: ${fragileAssertions.join(
					'; ',
				)}. You have no database access, so don't hardcode what the real total is — read it live instead: parse the pager's own current total from its text (don't assert it equals a literal number), paginate through every page collecting every row, assert each row actually matches what you searched for, then assert the number of rows you collected equals the total you read — that's a completeness check that's stable forever because both sides come from this same run. Also create your own record tagged with something unique to this run and confirm it's among the collected rows, to prove the results are live, not stale. Rewrite the assertion and call write_test_file again.`,
			};
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
			requiresFreshSession,
		);

		return {ok: true, data: {path: resolved}};
	},
};
