import type {EnvironmentSetupContext, ToolDefinition} from './types.js';

export type SignalEnvironmentReadyArgs = {
	notes: string;
	setupProcedure: string | null;
	apiCheck: {route: string; status: number} | null;
};

export type SignalEnvironmentReadyResult = {
	notes: string;
	setupProcedure?: string;
};

// The environment setup agent's only terminal tool, mirroring
// report_result's role for the testing agent. Its invocation is what ends
// the loop — the notes content is never trusted as proof the environment is
// actually ready; the caller independently re-checks reachability
// afterward. There's no harm in this being called and being wrong (for
// `notes`/`setupProcedure` — see apiCheck below for the one exception),
// so it only ever needs a best-effort summary of what was attempted.
export const signalEnvironmentReadyTool: ToolDefinition<
	SignalEnvironmentReadyArgs,
	SignalEnvironmentReadyResult,
	EnvironmentSetupContext
> = {
	name: 'signal_environment_ready',
	description:
		"Call this exactly once, when you believe the project's dev environment is up and reachable at the configured baseUrl. This is not taken as proof by itself — reachability is re-checked independently afterward — so call it as soon as you believe you are done rather than trying to perfectly verify it yourself first.",
	parameters: {
		type: 'object',
		properties: {
			notes: {
				type: 'string',
				description:
					'A short summary of what you did to bring the environment up, for the record if reachability still fails afterward.',
			},
			setupProcedure: {
				type: ['string', 'null'],
				description:
					"A clean, minimal, step-by-step Markdown recipe of exactly the commands that actually got the environment running — skip every dead end, failed attempt, and diagnostic command you ran along the way, keep only the sequence that worked. This gets saved as the project's setup instructions so a future run can follow it directly instead of rediscovering it. Set this ONLY if you had no documented setup instructions to follow and had to work it out yourself. Pass null if you were already following documented instructions.",
			},
			apiCheck: {
				type: ['object', 'null'],
				description:
					"The real, data-backed API route you actually curled with run_command (not baseUrl itself, and not a static page) plus the HTTP status it returned — proof the app's backend (and whatever database it reads from) is genuinely working, not just that a frontend process is listening. A page can load fine while every API call behind it fails, and that failure is invisible from baseUrl alone. Pass null ONLY if this project genuinely has no separate backend/API to check (a static site). If you started more than one service, check one that depends on the others (e.g. a route the frontend proxies to a backend that itself queries a database) so a single check verifies the whole chain.",
				properties: {
					route: {type: 'string'},
					status: {type: 'number'},
				},
				required: ['route', 'status'],
				additionalProperties: false,
			},
		},
		required: ['notes', 'setupProcedure', 'apiCheck'],
	},
	async execute({notes, setupProcedure, apiCheck}) {
		if (apiCheck && apiCheck.status >= 500) {
			return {
				ok: false,
				error: `You reported checking ${apiCheck.route} and getting back status ${apiCheck.status} — that's not a working environment, it's a backend (or the database behind it) that still isn't up. Fix whatever that status indicates and check again before signaling ready.`,
			};
		}

		return {
			ok: true,
			data: {notes, setupProcedure: setupProcedure ?? undefined},
		};
	},
};
