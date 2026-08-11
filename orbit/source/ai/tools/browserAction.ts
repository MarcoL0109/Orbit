import type {BrowserWorkerResponse} from '../browserWorker.js';
import type {ToolDefinition, ToolResult} from './types.js';

export type BrowserActionArgs = {
	action: 'navigate' | 'click' | 'fill' | 'snapshot' | 'reset';
	url: string | null;
	selector: string | null;
	value: string | null;
};

function toToolResult(
	response: BrowserWorkerResponse,
): ToolResult<BrowserWorkerResponse> {
	return response.ok
		? {ok: true, data: response}
		: {ok: false, error: response.error};
}

// 'close' is deliberately not an agent-facing action — the browser's
// lifecycle belongs to the run (see agent.ts's finally), not to the model;
// there's no legitimate reason for the agent to end it mid-run.
export const browserActionTool: ToolDefinition<
	BrowserActionArgs,
	BrowserWorkerResponse
> = {
	name: 'browser_action',
	description:
		'Interact with a real, running browser to ground exploration in what actually renders, instead of guessing from source. "navigate" loads a URL. "click" and "fill" act on a Playwright locator string (e.g. role=button[name="Submit"], text=..., or CSS) and, like navigate, return the resulting accessibility snapshot only if the page actually changed. "snapshot" always returns the current accessibility tree regardless of change, for an explicit re-check. "reset" starts a clean browser context (fresh cookies/storage) — call it when starting exploration for a NEW feature, never between pages within the same feature\'s flow, since a multi-page flow depends on staying in the same context. It also refuses to run if you have an unused value from request_user_input pending (use it in a fill first) — resetting mid-flow with a manually-obtained value still outstanding throws away the exact session that value was tied to. Every response may also include apiCalls (every XHR/fetch request the page made since the last action, success or failure, each with its status and body) and consoleErrors (browser console errors and uncaught exceptions). Check these before concluding anything about a silent failure. A 4xx/5xx entry with a real error message is direct evidence of an application bug — stop retrying different selectors or inputs, that will not fix a server error. Just as important: a 2xx entry whose body clearly contains data (e.g. a list of items) that the DOM snapshot does not show is evidence of a RENDERING bug — the request worked, the UI failed to display what it got back. Only when apiCalls is empty, or its data matches what the DOM shows, should an unexpected result be treated as your own selector or assumption being wrong rather than the app\'s.',
	parameters: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				enum: ['navigate', 'click', 'fill', 'snapshot', 'reset'],
				description: 'Which browser operation to perform.',
			},
			url: {
				type: ['string', 'null'],
				description:
					'URL to navigate to. Required for "navigate", null for every other action.',
			},
			selector: {
				type: ['string', 'null'],
				description:
					'Playwright locator string identifying the element. Required for "click" and "fill", null otherwise.',
			},
			value: {
				type: ['string', 'null'],
				description:
					'Text to type into the element. Required for "fill", null otherwise.',
			},
		},
		required: ['action', 'url', 'selector', 'value'],
	},
	async execute(args, context) {
		const worker = await context.getBrowserWorker();

		switch (args.action) {
			case 'navigate': {
				if (!args.url) return {ok: false, error: '"navigate" requires a url'};
				return toToolResult(
					await worker.send({action: 'navigate', url: args.url}),
				);
			}

			case 'click': {
				if (!args.selector)
					return {ok: false, error: '"click" requires a selector'};
				return toToolResult(
					await worker.send({action: 'click', selector: args.selector}),
				);
			}

			case 'fill': {
				if (!args.selector)
					return {ok: false, error: '"fill" requires a selector'};
				if (args.value === null)
					return {ok: false, error: '"fill" requires a value'};
				return toToolResult(
					await worker.send({
						action: 'fill',
						selector: args.selector,
						value: args.value,
					}),
				);
			}

			case 'snapshot': {
				return toToolResult(await worker.send({action: 'snapshot'}));
			}

			case 'reset': {
				if (context.hasUnconsumedManualInput()) {
					return {
						ok: false,
						error:
							'Refusing to reset: you have a value from request_user_input that has not been used in a fill yet. Resetting now throws away the session that value belongs to — if reaching this point again requires re-triggering the action that requested it (e.g. clicking "send code"), that repeats the real side effect and invalidates the value you were just given. Use the value first, then reset if you still need to.',
					};
				}

				return toToolResult(await worker.send({action: 'reset'}));
			}
		}
	},
};
