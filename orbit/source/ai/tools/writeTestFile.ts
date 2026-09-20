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
	seedingDecision: {
		preconditionNeeded: boolean;
		usedSeeding: boolean;
		reasoning: string;
	};
};

type WriteTestFileData = {
	path: string;
	seedingDecision: {
		preconditionNeeded: boolean;
		usedSeeding: boolean;
		reasoning: string;
	};
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
					'A bare filename, written directly into the configured test directory — e.g. "login.spec.ts". No subdirectories (no "sales/confirm.spec.ts") — every generated test lives flat at the same level, so its location is always predictable without having to search for it.',
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
					"true only if this test's own subject is login/authentication/session behavior itself (e.g. verifying login succeeds or fails, session expiry, logout) — almost always false. When true, run_test skips the shared pre-authenticated storageState for this file and lets it start from a genuinely fresh, logged-out browser, so it actually exercises what it claims to test rather than starting already signed in. Every other feature (creating, editing, searching, anything that merely NEEDS to be logged in to run) should be false and rely on the shared authenticated session instead of writing its own login steps.",
			},
			seedingDecision: {
				type: 'object',
				description:
					'Required for every write, not just when you do seed something. First decide preconditionNeeded: does this test need an existing/created record it does NOT itself test the creation of (e.g. "confirm" needs a quotation to already exist)? If preconditionNeeded is false (this test has nothing to seed — e.g. it IS the creation feature itself, or every step is its own subject), leave reasoning empty; there is nothing to explain. If preconditionNeeded is true, decide explicitly whether that precondition was seeded via a direct API call replaying a captured request (see "Seeding a precondition" in your instructions) instead of driven through the UI, and reasoning becomes required and must be specific: if a matching captured request was available this run and you used the UI flow anyway, say why (e.g. the captured body wasn\'t cleanly replayable JSON); if no matching capture was available, say that. A vague or generic answer is exactly as useless as no answer, since this is the only record of why a given run did or didn\'t seed.',
				properties: {
					preconditionNeeded: {
						type: 'boolean',
						description:
							"true if this test needs an existing/created record it does not itself test the creation of. false if this test's own subject already covers every record it touches (e.g. the creation feature itself), so there is nothing to seed.",
					},
					usedSeeding: {
						type: 'boolean',
						description:
							'Only meaningful when preconditionNeeded is true — false otherwise. true only if this file actually contains a page.request.post (or equivalent) replaying a captured request for that precondition.',
					},
					reasoning: {
						type: 'string',
						description:
							'Required and must be non-blank when preconditionNeeded is true — a specific, honest explanation for the usedSeeding value above, not a restatement of it. Leave empty when preconditionNeeded is false; there is nothing to explain.',
					},
				},
				required: ['preconditionNeeded', 'usedSeeding', 'reasoning'],
				additionalProperties: false,
			},
		},
		required: [
			'relativePath',
			'content',
			'features',
			'requiresFreshSession',
			'seedingDecision',
		],
	},
	async execute(
		{relativePath, content, features, requiresFreshSession, seedingDecision},
		context,
	) {
		// Same enforcement report_result already applies to rootCause — a
		// blank or missing reasoning is exactly as useless as no field at
		// all, and without a check nothing stops the model from technically
		// satisfying the schema with an empty string. Only enforced when a
		// precondition actually exists to reason about — a test with none
		// (e.g. the creation feature itself) has nothing to explain, and
		// forcing boilerplate there would just be noise on every single
		// write, not a real record of anything.
		if (
			seedingDecision?.preconditionNeeded &&
			!seedingDecision.reasoning?.trim()
		) {
			return {
				ok: false,
				error:
					'seedingDecision.reasoning is required and cannot be blank when preconditionNeeded is true — explain, specifically, whether a captured request was available for it this run and why you did or did not seed it. Call write_test_file again with that filled in.',
			};
		}

		// Enforced, not just described in the schema — nothing else stops
		// the model from nesting one file under a subdirectory while every
		// other one it wrote stays flat, and it has: confirmed directly,
		// the same "confirm" feature got written into a "sales/" folder
		// twice across separate runs while its sibling test files (create,
		// search) stayed at the top level. No ambiguity here (unlike the
		// seeding case) — a path separator either is or isn't present.
		if (relativePath.includes('/') || relativePath.includes(path.sep)) {
			return {
				ok: false,
				error: `relativePath must be a bare filename with no subdirectory — got "${relativePath}". Every generated test lives flat in the configured test directory; write it as just the filename (e.g. "${path.basename(
					relativePath,
				)}") instead.`,
			};
		}

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
			seedingDecision,
		);

		return {ok: true, data: {path: resolved, seedingDecision}};
	},
};
