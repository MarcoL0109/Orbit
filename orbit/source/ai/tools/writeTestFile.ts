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
					'Required for every write, not just when you do seed something — and that includes justifying preconditionNeeded itself, not just what you did once it\'s true. First decide preconditionNeeded: does this test need an existing/created record it does NOT itself test the creation of (e.g. "confirm" needs a quotation to already exist)? Either way, reasoning is required and must explain THAT decision specifically: if preconditionNeeded is true, say whether a matching captured request was available this run and why you did or did not seed it; if preconditionNeeded is false, say WHY there is no precondition here — e.g. "this test IS the creation feature itself" or "every record this test touches is created within the test\'s own subject action, not before it" — not just the bare word false with nothing behind it. A wrong "false" is exactly as costly a mistake as a wrong "true" would be, and it can only be caught after the fact if the reasoning for it was actually written down. A vague or generic answer is exactly as useless as no answer, since this is the only record of why a given run did or didn\'t seed.',
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
							'Required and must be non-blank in every case, whether preconditionNeeded is true or false — see the parent description for what each case must actually explain.',
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
		// satisfying the schema with an empty string. Enforced unconditionally
		// now, not just when preconditionNeeded is true — confirmed directly,
		// a real run marked a "confirm a quotation" feature preconditionNeeded:
		// false with reasoning left blank, silently skipping seeding on a
		// feature whose own schema description names it as the canonical true
		// example. A wrong "false" is exactly as costly as a wrong "true", and
		// requiring a real justification for it is the only way a mistake like
		// that is ever visible after the fact instead of silently accepted.
		if (!seedingDecision?.reasoning?.trim()) {
			return {
				ok: false,
				error:
					'seedingDecision.reasoning is required and cannot be blank, whether preconditionNeeded is true or false. If true, explain whether a captured request was available and why you did or did not seed it. If false, explain WHY there is no precondition here — a bare "false" with no justification is not acceptable, since a wrong false is exactly as costly a mistake as a wrong true. Call write_test_file again with that filled in.',
			};
		}

		// Mechanical, not just described in the schema — the "seed it whenever
		// a matching capture exists this run" rule has been talked around with
		// self-invented exceptions the instructions never actually grant
		// ("exercise the full UI path end to end", "avoid replaying a large
		// body"), not just the two narrow, named ones (not JSON; a one-time
		// token tied to that page load). A free-text reasoning field can't be
		// checked for whether its excuse is one of those two or a new one made
		// up on the spot — but whether a genuinely replayable capture exists
		// at all is a plain fact this run's own steps already contain, so
		// check that directly instead of trusting the excuse. Confirmed
		// directly against a real run: usedSeeding stayed false across three
		// separate reasons in a row — first no matching capture at all, then a
		// capture that failed to actually get recorded, then (once a real one
		// finally existed) reasons like these that dodge using it anyway.
		//
		// Reads context.getSeedableCandidates() rather than calling
		// collectSeedableRequestsThisRun directly — that gives this gate
		// whatever Jev's own noise filter already narrowed the candidates
		// down to this turn (when Jev is configured and covers the current
		// set), so a POST-tunneled read that merely happens to carry a JSON
		// body doesn't trip this the same way a genuine mutation does. See
		// seedRequestJev.ts's seedableCandidatesForGate.
		if (seedingDecision.preconditionNeeded && !seedingDecision.usedSeeding) {
			const seedable = context
				.getSeedableCandidates()
				.find(call =>
					(call.requestContentType ?? '').toLowerCase().includes('json'),
				);
			if (seedable) {
				return {
					ok: false,
					error: `seedingDecision says usedSeeding: false, but a genuinely replayable state-mutating request was captured live this run and is available to seed this precondition from: ${seedable.method} ${seedable.url}. Seeding whenever a matching capture exists is not optional and not a matter of preference — it applies regardless of the body's size, and "exercising the full UI path end to end" is exactly what seeding exists to avoid repeating on every single run of this test from here on; the feature under test is whatever this file's own subject is, not the precondition that gets you there. Either replay this exact captured request as the seed (see "Seeding a precondition" in your instructions) and set usedSeeding: true, or — ONLY if this specific request truly cannot be replayed, not because it's inconvenient or large, but because it isn't JSON or carries a one-time token tied to this exact page load — explain that precise technical reason in seedingDecision.reasoning. Call write_test_file again.`,
				};
			}
		}

		// Mechanical, not just described in the schema — "paste the captured
		// body as a raw JSON string and parse it... rather than hand-retyping
		// it as a JS object literal" (see "Seeding a precondition" in your
		// instructions) has been violated even though the instructions name
		// the exact failure it causes. Confirmed directly: a written test
		// hand-retyped a captured web_save body as a JS object literal instead
		// of JSON.parse(String.raw`...`), and in doing so silently dropped the
		// large "specification" argument the server actually required — the
		// server rejected the call (HTTP 200 with a JSON-RPC error body, since
		// this backend embeds failures in the body rather than the status),
		// and the test only found out two lines later as a confusing raw
		// TypeError instead of a clear setup failure. Whether the pasted-JSON
		// pattern is actually present is a plain, checkable fact about the
		// file's own text — no need to trust that hand-retyping was faithful
		// when it doesn't need to happen at all.
		if (
			seedingDecision.usedSeeding &&
			!content.includes('JSON.parse(String.raw')
		) {
			return {
				ok: false,
				error:
					'seedingDecision says usedSeeding: true, but this file does not contain the JSON.parse(String.raw`...`) pattern your instructions require for a seeded precondition body. Hand-retyping the captured body as a JS object literal is exactly what invites silently dropping a field the server actually needs (e.g. a large "specification"/"context" argument that looks like unrelated boilerplate) — paste the captured requestBody verbatim inside JSON.parse(String.raw`...`) instead, and override only the one traced field on the parsed object afterward. Call write_test_file again with the seed body rewritten that way.',
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
