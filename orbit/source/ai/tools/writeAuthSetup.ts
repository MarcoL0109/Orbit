import fs from 'node:fs';
import path from 'node:path';
import {getOrbitDir} from '../../init/orbitDir.js';
import {findUnverifiedNames} from '../verifiedSelectors.js';
import type {ToolDefinition} from './types.js';

type WriteAuthSetupArgs = {
	content: string;
};

type WriteAuthSetupData = {
	path: string;
};

export function getAuthSetupPath(projectRoot: string): string {
	return path.join(getOrbitDir(projectRoot), 'index', 'auth.setup.ts');
}

// Single source of truth for where the saved session lives — run_test.ts
// (writes it fresh before every real test run) and browserWorker.ts (reads
// it opportunistically for live exploration) both need the exact same path,
// and duplicating this string construction in three places is exactly how
// they'd quietly drift apart.
export function getStorageStatePath(projectRoot: string): string {
	return path.join(getOrbitDir(projectRoot), 'index', 'storage-state.json');
}

// Written once per project (not once per feature, unlike write_test_file) —
// the login flow it captures is reused by every subsequent test via a
// shared storageState, exactly so those tests never need to write their own
// login steps at all. See run_test.ts for how the resulting file actually
// gets executed and turned into storage-state.json before the real test
// runs, and agent.ts's prompt for when the model should call this versus
// just writing a normal test.
export const writeAuthSetupTool: ToolDefinition<
	WriteAuthSetupArgs,
	WriteAuthSetupData
> = {
	name: 'write_auth_setup',
	description:
		'Write the shared login flow that every other generated test will start already authenticated from, instead of each one repeating its own login steps. Call this once you have verified the login flow live — the content must be a complete Playwright test file whose final action saves the authenticated session via `await page.context().storageState({ path: process.env.ORBIT_STORAGE_STATE_PATH })`. Do not call this for a feature whose own subject is login/session/authentication itself — write that as a normal write_test_file instead, with requiresFreshSession set to true, so it actually exercises a real login rather than starting pre-authenticated.',
	parameters: {
		type: 'object',
		properties: {
			content: {
				type: 'string',
				description:
					'The full contents of the auth setup file — a Playwright test that logs in and ends with page.context().storageState({ path: process.env.ORBIT_STORAGE_STATE_PATH }).',
			},
		},
		required: ['content'],
	},
	async execute({content}, context) {
		// Same reasoning as write_test_file's own gate — the login selectors
		// here are exactly as load-bearing for every other test as any
		// selector in a real test file, so they get the same live-verification
		// requirement, not a pass because this file happens to be singular.
		if (context.orbitConfig.blind) {
			const unverifiedNames = findUnverifiedNames(content, context.getSteps());
			if (unverifiedNames.length > 0) {
				return {
					ok: false,
					error: `This blind project has no source to fall back on, so every interactive element this auth setup references must trace back to something you actually clicked or filled live via browser_action this run. No verified action this run matches: ${unverifiedNames
						.map(name => `"${name}"`)
						.join(
							', ',
						)}. Go verify each of these live with browser_action, then call write_auth_setup again.`,
				};
			}
		}

		if (!content.includes('storageState(')) {
			return {
				ok: false,
				error:
					'This file must end by saving the authenticated session via page.context().storageState({ path: process.env.ORBIT_STORAGE_STATE_PATH }) — every other test depends on this file actually producing that file, not just performing a login that goes nowhere.',
			};
		}

		if (context.orbitConfig.writeMode === 'ask') {
			const approved = await context.requestApproval(
				'Write shared auth setup (used by every other generated test)?',
			);
			if (!approved) {
				return {ok: false, error: 'User declined the write'};
			}
		}

		const resolved = getAuthSetupPath(context.projectRoot);

		try {
			fs.mkdirSync(path.dirname(resolved), {recursive: true});
			fs.writeFileSync(resolved, content, 'utf8');
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		return {ok: true, data: {path: resolved}};
	},
};
