import type {ToolDefinition} from './types.js';
import {recordFailureNote} from '../../init/memory.js';

// What the model itself supplies via report_result. Kept separate from
// FeatureResult (below) because one field of the final, stored result —
// playwrightStage — is deliberately never trusted to the model's own
// self-report: it's derived by agent.ts directly from run_test's actual
// structured result, the one stage of the three with real ground truth
// available. The model literally cannot set it (it's not in this type or
// the tool's JSON schema at all).
export type FeatureResultInput = {
	feature: string;
	// Null when requiresManualInput is true and no test file was written —
	// a persisted test for a flow gated behind manually-supplied, single-use
	// external input (an emailed code, etc.) can't pass unattended on a
	// future run, and reaching the same point again would repeat whatever
	// real side effect that step has (e.g. sending another real email) every
	// time it runs. Non-null otherwise.
	file: string | null;
	status: 'passed' | 'failed' | 'gave_up';
	summary: string;
	// Non-null exactly when status is 'failed' or 'gave_up' (checked below,
	// same enforcement style as confidence/confirm_outcome) — a specific,
	// evidence-backed diagnosis, not a restatement of `summary`. This is
	// what recordFailureNote persists to failures.md for a future run to
	// read, so a vague entry here is exactly as useless as no entry at all;
	// see the field's own description for what counts as specific enough.
	rootCause: string | null;
	// The pipeline has three real stages — live exploration, the backend/API
	// call, and the written Playwright test — and any one of them can be the
	// actual point of failure while the others are fine (confirmed live: a
	// run where exploration worked and the backend genuinely saved the
	// record, but the written test's own assertion checked the wrong field).
	// These two are self-reported because there's no automatic ground truth
	// for them the way there is for run_test's result; see backendResult's
	// own description for why "the UI looked fine" is not enough evidence.
	explorationResult: 'passed' | 'failed' | 'not-attempted';
	explorationReason: string;
	backendResult: 'confirmed-success' | 'confirmed-failure' | 'unverified';
	backendReason: string;
	// True if this feature's test needed request_user_input to get past a
	// step it can't automate unattended (e.g. a one-time code). status still
	// reflects the run's actual pass/fail — this only flags that a human was
	// involved, so a "passed" run doesn't get mistaken for a fully
	// unattended-repeatable one.
	requiresManualInput: boolean;
	// The manually-assisted step's own outcome, kept separate from `status`
	// since the two can diverge (e.g. the manual step succeeded but a later,
	// unrelated assertion failed). Non-null exactly when requiresManualInput
	// is true — this is what actually answers "did the manual part work",
	// not just prose in `summary` that the model might forget to include.
	manualStepOutcome: 'succeeded' | 'failed' | null;
	// Required, not optional — the model must explicitly commit to one or
	// the other for every result, not just the ones it happens to flag.
	// 'uncertain' is checked below: it's only accepted if confirm_outcome
	// was already called for this exact feature. This is what actually
	// enforces asking the user on a genuinely ambiguous result instead of
	// leaving it to the model's own discretion about whether to bother.
	confidence: 'certain' | 'uncertain';
};

// The full, stored/returned shape — everything a caller (formatAgentRunResult,
// agentRunResultToJson, session.ts) actually works with. Only ever
// constructed in one place: runTestingAgent, right after report_result
// succeeds, by attaching the derived playwrightStage to each of the
// model's own FeatureResultInput entries.
export type FeatureResult = FeatureResultInput & {
	playwrightStage: 'passed' | 'failed' | 'not-run';
};

export type ReportResultArgs = {
	results: FeatureResultInput[];
};

// The loop's only terminal tool. The model must call this exactly once to
// end the run — no tool call at all is treated as an error, not a finish
// (see agent.ts). One result per feature, since features get separate test
// files (see the system prompt) and can independently pass/fail.
export const reportResultTool: ToolDefinition<
	ReportResultArgs,
	ReportResultArgs
> = {
	name: 'report_result',
	description:
		'Call this exactly once, when finished with every feature, to report the outcome of each one.',
	parameters: {
		type: 'object',
		properties: {
			results: {
				type: 'array',
				description: 'One entry per feature you were asked to test.',
				items: {
					type: 'object',
					properties: {
						feature: {
							type: 'string',
							description: 'Short name of the feature, e.g. "login"',
						},
						file: {
							type: ['string', 'null'],
							description:
								'Path (relative to the test directory) of the test file written for this feature, or null if requiresManualInput is true and you deliberately did not write one (see requiresManualInput).',
						},
						status: {
							type: 'string',
							enum: ['passed', 'failed', 'gave_up'],
							description:
								'"passed" if this feature\'s test now passes, "failed" if it does not and no more repair attempts remain for it, "gave_up" if this feature could not be tested at all',
						},
						summary: {
							type: 'string',
							description: "One or two sentences on this feature's outcome.",
						},
						rootCause: {
							type: ['string', 'null'],
							description:
								'Required (non-null) when status is "failed" or "gave_up"; must be null when status is "passed". The SPECIFIC reason this failed, backed by evidence you actually saw — the exact selector/action that failed and why, quoting or closely paraphrasing the real error from run_test\'s failure output or a browser_action snapshot. Not a restatement of what you were trying to do or a vague guess. Bad (rejected in spirit even if technically non-null): "Test consistently timed out while creating the quotation" or "needs investigation". Good: "getByRole(\'combobox\').click() for the app switcher was intercepted by its own already-open dropdown grid — the apps grid is already visible right after login, no combobox click is needed." If you cannot state a cause this specific, look again at run_test\'s error/stackTrace or take a fresh browser_action snapshot before calling report_result — do not guess.',
						},
						explorationResult: {
							type: 'string',
							enum: ['passed', 'failed', 'not-attempted'],
							description:
								'"passed" if you completed this feature\'s flow live end-to-end with browser_action and it behaved as expected. "failed" if live exploration itself hit a real problem (a click that never landed, a page that never loaded, a flow that genuinely doesn\'t work as described). "not-attempted" if you never explored this feature live at all (e.g. went straight to request_user_input, or reused an already-known selector without re-verifying).',
						},
						explorationReason: {
							type: 'string',
							description:
								'One line, specific to exploration — what you actually observed live, not a copy of summary/rootCause. E.g. "Completed login -> Sales -> New quotation -> save live, saw the record reference change." Do not leave this generic.',
						},
						backendResult: {
							type: 'string',
							enum: ['confirmed-success', 'confirmed-failure', 'unverified'],
							description:
								'Whether you actually saw the real server response for the state-changing request (create/save/submit/etc.) succeed. "confirmed-success" only when you checked the actual response — via browser_action\'s apiCalls, or an explicit network wait in the written test — and it returned success. "confirmed-failure" if you saw it error or return something unexpected. "unverified" if you never actually checked the request/response and only inferred success from how the UI looked — the UI looking fine is NOT enough evidence for "confirmed-success"; that gap is exactly what caused a past run to report a false pass with no record ever actually saved.',
						},
						backendReason: {
							type: 'string',
							description:
								'One line, specific to the backend/API check — which request you checked and what it returned (e.g. "web_save RPC returned 200 with the new record id"), or why you could not verify it. Do not leave this generic.',
						},
						requiresManualInput: {
							type: 'boolean',
							description:
								'true if you called request_user_input anywhere while testing this feature, false otherwise.',
						},
						manualStepOutcome: {
							type: ['string', 'null'],
							enum: ['succeeded', 'failed'],
							description:
								'Whether the manually-assisted step itself worked once given the value (e.g. the activation code actually activated the account) — not the overall test status. Required (non-null) when requiresManualInput is true; must be null when it is false.',
						},
						confidence: {
							type: 'string',
							enum: ['certain', 'uncertain'],
							description:
								"Mark 'uncertain' if you cannot confidently tell whether this outcome is actually correct — no decisive apiCalls/consoleErrors evidence either way, a live interaction (drag-and-drop, complex gestures) Playwright may not simulate reliably, or timing/environment-sensitive behavior. If 'uncertain', you must have already called confirm_outcome for this exact feature, or this call is rejected. Mark 'certain' only when the evidence actually supports it, not by default to skip confirm_outcome.",
						},
					},
					required: [
						'feature',
						'file',
						'status',
						'summary',
						'rootCause',
						'explorationResult',
						'explorationReason',
						'backendResult',
						'backendReason',
						'requiresManualInput',
						'manualStepOutcome',
						'confidence',
					],
					additionalProperties: false,
				},
			},
		},
		required: ['results'],
	},
	async execute(args, context) {
		const unconfirmed = args.results.filter(
			result =>
				result.confidence === 'uncertain' &&
				!context.hasConfirmedOutcome(result.feature),
		);

		if (unconfirmed.length > 0) {
			const features = unconfirmed
				.map(result => `"${result.feature}"`)
				.join(', ');
			return {
				ok: false,
				error: `Marked ${features} as confidence: 'uncertain' but never called confirm_outcome for ${
					unconfirmed.length === 1 ? 'it' : 'them'
				}. Call confirm_outcome for each of these features first, then call report_result again.`,
			};
		}

		// A missing rootCause is the one thing checked in code (an absent
		// diagnosis is unambiguous); a vague-but-present one is not
		// mechanically detectable, so the parameter description carries the
		// rest of the bar via good/bad examples. Still catches the exact
		// failure mode observed live: a result reported failed with nothing
		// beyond `summary` to say why.
		const missingRootCause = args.results.filter(
			result =>
				(result.status === 'failed' || result.status === 'gave_up') &&
				!result.rootCause?.trim(),
		);

		if (missingRootCause.length > 0) {
			const features = missingRootCause
				.map(result => `"${result.feature}"`)
				.join(', ');
			return {
				ok: false,
				error: `${features} ${
					missingRootCause.length === 1 ? 'is' : 'are'
				} marked failed/gave_up but rootCause is missing. State the specific, evidence-backed reason it failed — check run_test's error/stackTrace or take a browser_action snapshot first if you're not already certain — then call report_result again with rootCause filled in.`,
			};
		}

		// Same shape as the rootCause check above: presence is all that's
		// mechanically checkable, so this only catches an empty/blank reason,
		// not a vague-but-present one — the schema descriptions carry the rest.
		const missingStageReasons = args.results.filter(
			result =>
				!result.explorationReason?.trim() || !result.backendReason?.trim(),
		);

		if (missingStageReasons.length > 0) {
			const features = missingStageReasons
				.map(result => `"${result.feature}"`)
				.join(', ');
			return {
				ok: false,
				error: `${features} ${
					missingStageReasons.length === 1 ? 'is' : 'are'
				} missing explorationReason and/or backendReason. Every result needs a one-line reason for both stages — what you actually observed during live exploration, and whether you actually checked the real backend response — even when the stage passed. Call report_result again with both filled in.`,
			};
		}

		// Best-effort, never blocks the actual report — a future run reads
		// these back via project memory (see agent.ts's system prompt), so a
		// failed feature this run becomes a documented pattern the next one
		// starts already knowing about, instead of rediscovering it cold.
		for (const result of args.results) {
			if (result.status === 'failed' || result.status === 'gave_up') {
				try {
					recordFailureNote(context.projectRoot, {
						feature: result.feature,
						status: result.status,
						rootCause: result.rootCause!,
					});
				} catch {
					// Non-fatal — the result itself still gets reported below.
				}
			}
		}

		return {ok: true, data: args};
	},
};
