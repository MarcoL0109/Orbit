import type {OrbitConfig} from '../../init/config.js';
import type {BrowserWorkerHandle} from '../browserWorker.js';

export type ToolResult<T = unknown> =
	| {ok: true; data: T}
	| {ok: false; error: string};

export type ToolContext = {
	projectRoot: string;
	orbitConfig: OrbitConfig;
	signal: AbortSignal;
	// Resolves once the user responds in the Ink UI. Only awaited when the
	// relevant OrbitConfig mode is 'ask' — tools decide when to call this,
	// the loop doesn't force it.
	requestApproval: (description: string) => Promise<boolean>;
	// Resolves with what the user typed, or null if they declined (Esc) —
	// for external data the agent has no other way to obtain (a code sent
	// by email/SMS, a secret only the user has). See request_user_input.
	requestInput: (prompt: string) => Promise<string | null>;
	// True once at least one browser_action call has been made this run.
	// request_user_input checks this and refuses to fire otherwise — a
	// prompt-only "don't ask in advance" instruction wasn't reliable enough
	// on its own (observed asking as literally the first tool call), so this
	// is enforced in code instead of trusted to wording.
	hasExploredWithBrowser: () => boolean;
	// True from the moment request_user_input returns a value until the next
	// successful browser_action fill — i.e. "a manually-obtained value exists
	// that hasn't been used yet." browser_action's reset checks this and
	// refuses while it's true: the value is tied to the exact session it was
	// obtained in, and resetting throws that session away — if getting back
	// to the same point means re-triggering whatever action requested the
	// value in the first place (e.g. "send code"), that repeats the real
	// side effect and invalidates the value the user already gave.
	hasUnconsumedManualInput: () => boolean;
	// Lazily spawns (or reuses, or respawns after a crash) the one browser
	// worker for this run — see agent.ts, which owns the actual lifecycle
	// and cleanup. Tools never spawn or close it themselves.
	getBrowserWorker: () => Promise<BrowserWorkerHandle>;
	// Resolves once the user picks Success or Failure in the Ink UI — see
	// confirm_outcome. Not for gathering new information (that's
	// requestInput's job); this only ever judges something the agent already
	// did and shows evidence for.
	requestOutcomeConfirmation: (
		feature: string,
		whatWasDone: string,
		output: string,
	) => Promise<'success' | 'failure'>;
	// True once confirm_outcome has resolved for this exact feature name,
	// this run. report_result checks this itself (see reportResult.ts) —
	// a result marked confidence: 'uncertain' is rejected unless this is
	// true for that feature, so asking the user isn't left to the model's
	// own discretion about whether it feels unsure enough to bother.
	hasConfirmedOutcome: (feature: string) => boolean;
};

// Deliberately smaller than ToolContext — the environment setup agent's
// tools (run_command, signal_environment_ready) have no use for
// browser/manual-input state, so they don't get fields that don't apply.
export type EnvironmentSetupContext = {
	projectRoot: string;
	orbitConfig: OrbitConfig;
	signal: AbortSignal;
	requestApproval: (description: string) => Promise<boolean>;
};

// A minimal JSON Schema object — only what's needed to describe a tool's
// parameters to the model, not a general-purpose schema type.
//
// Tools are registered in strict mode (see toApiToolSchema), which the API
// enforces via constrained decoding — every property must be listed in
// `required`; there is no such thing as an omittable property. Represent an
// optional argument as a nullable type instead, e.g.
// `{type: ['string', 'null']}` with the name still present in `required`,
// and treat `null` as "not provided" in `execute`. See run_test's filePath.
export type JsonSchema = {
	type: 'object';
	properties: Record<string, unknown>;
	required?: string[];
};

// Ctx defaults to ToolContext so every existing tool (testing-agent tools)
// needs no changes — only a tool family with a genuinely different, smaller
// context (see the environment setup agent's tools) specifies it explicitly.
export type ToolDefinition<Args = any, Data = any, Ctx = ToolContext> = {
	name: string;
	description: string;
	parameters: JsonSchema;
	execute: (args: Args, context: Ctx) => Promise<ToolResult<Data>>;
};
