import type React from 'react';
import type {CommandContext, Message} from './context.js';

// The set of errors that can arise while dispatching or running an Orbit
// command. Adding a new kind of error means adding a case here and to
// describeOrbitError below — the compiler will flag any switch that forgets
// a case, so new error kinds can't silently end up undescribed.
export type OrbitError =
	| {kind: 'invalid-arg-count'; usage: string; expected: string; given: number}
	| {kind: 'task-in-progress'}
	| {kind: 'unknown-command'; commandName: string}
	| {kind: 'no-project-selected'}
	| {kind: 'invalid-project-path'; path: string}
	| {kind: 'project-already-initialized'}
	| {kind: 'project-not-initialized'}
	| {kind: 'invalid-blind-url'; url: string}
	| {kind: 'post-init-scan-failed'; cause: unknown}
	// The environment setup agent never called signal_environment_ready —
	// ran out of steps, or genuinely couldn't proceed (e.g. a needed
	// command was declined). Distinct from the case below: this means it
	// never believed it finished at all.
	| {kind: 'environment-setup-gave-up'; notes: string}
	// It called signal_environment_ready, but the independent reachability
	// check afterward still failed — it believed it was done and was
	// wrong. Kept separate from the above since "confidently wrong" is a
	// more actionable signal than "never got there."
	| {kind: 'environment-not-reachable'; baseUrl: string; notes: string}
	// Blind mode's own unreachable case — deliberately not folded into
	// environment-not-reachable above, whose wording ("the setup agent
	// believed it finished...") assumes a setup agent actually ran. Blind
	// mode never runs one at all, so it needs its own accurate message.
	| {kind: 'blind-target-unreachable'; baseUrl: string}
	| {kind: 'unexpected'; action: string; cause: unknown};

export type ArgCountRule = {exact: number} | {min: number};

type SetMessages = React.Dispatch<React.SetStateAction<Message[]>>;

function causeMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function describeOrbitError(error: OrbitError): string {
	switch (error.kind) {
		case 'invalid-arg-count': {
			return `${error.usage} expects ${error.expected} arg(s), ${error.given} given`;
		}

		case 'task-in-progress': {
			return 'There is ongoing task Orbit is handling. You can use the /abort command to terminate previous task';
		}

		case 'unknown-command': {
			return `
Unknown command: /${error.commandName}
Type /help to see available commands.`;
		}

		case 'no-project-selected': {
			return 'No valid project selected. Please select or open a project first.';
		}

		case 'invalid-project-path': {
			return `${error.path} does not exist or is not a directory.`;
		}

		case 'project-already-initialized': {
			return 'Orbit context is already initialized. You can use /scan to refresh the context, or delete the .orbit folder and run /init again.';
		}

		case 'project-not-initialized': {
			return 'This project has no Orbit context yet. Run /init first.';
		}

		case 'invalid-blind-url': {
			return `"${error.url}" isn't a valid http(s) URL. /blind needs the full address of the running app, e.g. https://example.com.`;
		}

		case 'post-init-scan-failed': {
			return `Project initialized, but the initial scan failed: ${causeMessage(
				error.cause,
			)}`;
		}

		case 'environment-setup-gave-up': {
			return `Couldn't get the dev environment running: ${error.notes}`;
		}

		case 'environment-not-reachable': {
			return `The setup agent believed it finished, but ${error.baseUrl} still isn't reachable. What it did: ${error.notes}`;
		}

		case 'blind-target-unreachable': {
			return `${error.baseUrl} isn't reachable. Blind mode never tries to start or discover an environment for you — start the app yourself, then try again.`;
		}

		case 'unexpected': {
			return `${error.action} failed: ${causeMessage(error.cause)}`;
		}
	}
}

function severityColorFor(error: OrbitError): 'red' | 'yellow' {
	return error.kind === 'project-already-initialized' ? 'yellow' : 'red';
}

export function reportError(setMessages: SetMessages, error: OrbitError): void {
	setMessages(previous => [
		...previous,
		{
			role: 'system',
			content: describeOrbitError(error),
			color: severityColorFor(error),
		},
	]);
}

export function checkTaskInProgress(
	context: CommandContext,
): OrbitError | null {
	return context.isThinking ? {kind: 'task-in-progress'} : null;
}

export function checkArgCount(
	rule: ArgCountRule,
	given: number,
	usage: string,
): OrbitError | null {
	if ('exact' in rule) {
		return given === rule.exact
			? null
			: {kind: 'invalid-arg-count', usage, expected: `${rule.exact}`, given};
	}

	return given >= rule.min
		? null
		: {
				kind: 'invalid-arg-count',
				usage,
				expected: `at least ${rule.min}`,
				given,
		  };
}
