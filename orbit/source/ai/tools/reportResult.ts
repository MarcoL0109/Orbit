import type {ToolDefinition} from './types.js';

export type FeatureResult = {
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

export type ReportResultArgs = {
	results: FeatureResult[];
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

		return {ok: true, data: args};
	},
};
