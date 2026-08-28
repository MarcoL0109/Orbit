import type {BrowserWorkerResponse} from '../browserWorker.js';
import type {ToolDefinition, ToolResult} from './types.js';

export type BrowserActionArgs = {
	action:
		| 'navigate'
		| 'click'
		| 'fill'
		| 'selectOption'
		| 'press'
		| 'hover'
		| 'wait'
		| 'snapshot'
		| 'reset';
	url: string | null;
	selector: string | null;
	value: string | null;
	key: string | null;
	frame: string | null;
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
		'Interact with a real, running browser to ground exploration in what actually renders, instead of guessing from source. "navigate" loads a URL. "click" and "fill" act on a Playwright locator string (e.g. role=button[name="Submit"], text=..., or CSS). "selectOption" picks an option from a native HTML <select> by its visible label (in `value`) — use this instead of "click" for a native select; clicking a native <select>\'s own <option> elements is unreliable across browsers since they render as an OS-level popup outside the normal DOM click model. "press" sends a keyboard key (e.g. "Enter", "Tab", "Escape", "ArrowDown" — any Playwright key name) either to a focused element (pass `selector`) or globally (`selector: null`) — use this for anything that only responds to the keyboard: confirming an autocomplete\'s highlighted suggestion with Enter, closing a modal with Escape, navigating a custom menu with arrow keys. "hover" moves the pointer over an element without clicking — use this to reveal hover-only content (a submenu, a tooltip) that a click might not trigger, or might trigger something else entirely (e.g. navigate away). "wait" waits (up to 10s) for an element to reach a specific state — pass `value: "visible"` to wait for it to appear, or `value: "hidden"` to wait for it to disappear (e.g. a loading spinner). Use this instead of guessing that a normal action\'s brief automatic settle was enough — if you\'re not sure whether something async has finished rendering, wait for the specific element you actually need next rather than proceeding blind. click/fill/selectOption/press/hover/wait all return the resulting accessibility snapshot only if the page actually changed. "snapshot" always returns the current accessibility tree regardless of change, for an explicit re-check. `frame` targets an element inside an <iframe> instead of the main page — pass a Playwright locator string identifying the iframe element itself (e.g. role=iframe[name="payment"], or a CSS selector) and `selector` then resolves *inside* that frame, not the top-level page; applies to click/fill/selectOption/press/hover/wait/snapshot, and is ignored (must be null) for navigate/reset. The top-level snapshot does not show what\'s rendered inside an iframe, so if you suspect a piece of UI (a payment form, an embedded widget) lives in one, call "snapshot" with `frame` set to inspect that frame\'s own content before acting on it — leave `frame` null for anything on the main page, which is almost everything. "reset" starts a clean browser context (fresh cookies/storage) — call it when starting exploration for a NEW feature, never between pages within the same feature\'s flow, since a multi-page flow depends on staying in the same context. It also refuses to run if you have an unused value from request_user_input pending (use it in a fill first) — resetting mid-flow with a manually-obtained value still outstanding throws away the exact session that value was tied to. Every response may also include apiCalls (every XHR/fetch request the page made since the last action, success or failure, each with its status and body) and consoleErrors (browser console errors and uncaught exceptions). Check these before concluding anything about a silent failure. A 4xx/5xx entry with a real error message is direct evidence of an application bug — stop retrying different selectors or inputs, that will not fix a server error. Just as important: a 2xx entry whose body clearly contains data (e.g. a list of items) that the DOM snapshot does not show is evidence of a RENDERING bug — the request worked, the UI failed to display what it got back. A real-time feature (live updates, chat, multiplayer state) may instead — or additionally — use webSocketMessages, each a {url, direction: "sent"|"received", payload} for a message sent since the last action; treat a "received" message carrying data the DOM does not reflect exactly like an unrendered apiCalls response — a rendering bug, not your own mistake. Only when apiCalls and webSocketMessages are both empty, or their data matches what the DOM shows, should an unexpected result be treated as your own selector or assumption being wrong rather than the app\'s.',
	parameters: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				enum: [
					'navigate',
					'click',
					'fill',
					'selectOption',
					'press',
					'hover',
					'wait',
					'snapshot',
					'reset',
				],
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
					'Playwright locator string identifying the element. Required for "click", "fill", "selectOption", "hover", and "wait". Optional for "press" (a specific focused element, or null to send the key globally to the page). Null for "navigate"/"snapshot"/"reset".',
			},
			value: {
				type: ['string', 'null'],
				description:
					'For "fill": the text to type into the element. For "selectOption": the visible label of the option to select (not its underlying value attribute). For "wait": the state to wait for — "visible" or "hidden". Required for all three, null otherwise.',
			},
			key: {
				type: ['string', 'null'],
				description:
					'Key name for "press" (e.g. "Enter", "Tab", "Escape", "ArrowDown", "ArrowUp") — any Playwright keyboard key name. Required for "press", null otherwise.',
			},
			frame: {
				type: ['string', 'null'],
				description:
					'Playwright locator string identifying an <iframe> element, to resolve `selector` inside that frame instead of the main page. Optional for "click", "fill", "selectOption", "press", "hover", "wait", and "snapshot". Null for "navigate"/"reset", and null for anything on the main page (almost everything).',
			},
		},
		required: ['action', 'url', 'selector', 'value', 'key', 'frame'],
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
					await worker.send({
						action: 'click',
						selector: args.selector,
						frame: args.frame,
					}),
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
						frame: args.frame,
					}),
				);
			}

			case 'selectOption': {
				if (!args.selector)
					return {ok: false, error: '"selectOption" requires a selector'};
				if (args.value === null)
					return {
						ok: false,
						error:
							'"selectOption" requires a value (the option\'s visible label)',
					};
				return toToolResult(
					await worker.send({
						action: 'selectOption',
						selector: args.selector,
						label: args.value,
						frame: args.frame,
					}),
				);
			}

			case 'press': {
				if (!args.key) return {ok: false, error: '"press" requires a key'};
				return toToolResult(
					await worker.send({
						action: 'press',
						selector: args.selector,
						key: args.key,
						frame: args.frame,
					}),
				);
			}

			case 'hover': {
				if (!args.selector)
					return {ok: false, error: '"hover" requires a selector'};
				return toToolResult(
					await worker.send({
						action: 'hover',
						selector: args.selector,
						frame: args.frame,
					}),
				);
			}

			case 'wait': {
				if (!args.selector)
					return {ok: false, error: '"wait" requires a selector'};
				if (args.value !== 'visible' && args.value !== 'hidden') {
					return {
						ok: false,
						error: '"wait" requires value to be "visible" or "hidden"',
					};
				}
				return toToolResult(
					await worker.send({
						action: 'wait',
						selector: args.selector,
						state: args.value,
						frame: args.frame,
					}),
				);
			}

			case 'snapshot': {
				return toToolResult(
					await worker.send({action: 'snapshot', frame: args.frame}),
				);
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
