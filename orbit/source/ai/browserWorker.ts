import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export type BrowserWorkerCommand =
	| {action: 'navigate'; url: string}
	| {action: 'click'; selector: string}
	| {action: 'fill'; selector: string; value: string}
	// label, not value — selects a native <select>'s option by its visible
	// text. Matches how the model actually perceives options (it only ever
	// sees rendered labels via the accessibility snapshot, never the raw
	// value attribute, which can be arbitrary — confirmed live against a
	// real project where a native select's own value attribute was a
	// literal escaped-quoted string, nothing a model should have to guess).
	| {action: 'selectOption'; selector: string; label: string}
	// selector: null sends the key to the page globally (e.g. Escape to
	// close a modal with nothing specific focused); non-null presses it on
	// that one focused element (e.g. Enter after filling an autocomplete).
	| {action: 'press'; selector: string | null; key: string}
	| {action: 'hover'; selector: string}
	// Explicit wait for one element's state, separate from actAndReport's
	// own blanket settle() — that one's a generic, bounded-time nudge after
	// every action; this is for when the model specifically doesn't trust
	// that was enough and wants to wait for one particular element instead
	// of proceeding blind.
	| {action: 'wait'; selector: string; state: 'visible' | 'hidden'}
	| {action: 'snapshot'}
	| {action: 'reset'}
	| {action: 'close'};

export type ApiCall = {
	url: string;
	status: number;
	statusText: string;
	ok: boolean;
	body?: string;
};

export type WebSocketMessage = {
	url: string;
	direction: 'sent' | 'received';
	payload: string;
};

export type BrowserWorkerResponse =
	| {
			ok: true;
			url?: string;
			title?: string;
			changed?: boolean;
			snapshot?: string;
			// Populated only when non-empty, scoped to what happened during
			// THIS action specifically (cleared before, drained after) — not a
			// running log. Every XHR/fetch response the page made (success or
			// failure), not just failures — a 4xx/5xx entry is direct evidence
			// of an app bug, but a 200 matters too: if it carries data the DOM
			// doesn't show, that's a rendering bug, not a network one. Neither
			// is visible from the DOM snapshot alone.
			apiCalls?: ApiCall[];
			consoleErrors?: string[];
			// Same scoping as apiCalls — a real-time app (live scores, chat,
			// broadcasts) can drive most of its actual behavior over a
			// WebSocket instead of XHR/fetch, which apiCalls never sees at
			// all. A 'received' frame with data the DOM doesn't reflect is the
			// same rendering-bug signal as an unrendered 2xx apiCall.
			webSocketMessages?: WebSocketMessage[];
	  }
	| {ok: false; error: string};

export type BrowserWorkerHandle = {
	send: (command: BrowserWorkerCommand) => Promise<BrowserWorkerResponse>;
	isAlive: () => boolean;
	close: () => void;
};

const VALID_BROWSERS = new Set(['chromium', 'firefox', 'webkit']);

function resolveBrowserName(
	defaultBrowser: string,
): 'chromium' | 'firefox' | 'webkit' {
	return VALID_BROWSERS.has(defaultBrowser)
		? (defaultBrowser as 'chromium' | 'firefox' | 'webkit')
		: 'chromium';
}

// Generated into the target project's own .orbit/index/, so `import ...
// from 'playwright'` resolves the same way run_test's generated Playwright
// config already resolves '@playwright/test' — by walking up from that
// file's own directory to <projectRoot>/node_modules. '@playwright/test'
// depends on the full 'playwright' package (not '-core'), so this is
// guaranteed present whenever @playwright/test is installed.
//
// One process, one browser, launched lazily on first use. A single context
// persists across navigate/click/fill calls so a multi-page flow (cart ->
// checkout -> payment) keeps its session — 'reset' is the only thing that
// tears the context down and starts clean, left to the caller to invoke at
// feature boundaries, not page boundaries.
function buildBrowserWorkerSource(
	browserName: 'chromium' | 'firefox' | 'webkit',
	baseUrl: string,
): string {
	return `import { ${browserName} as launchBrowser } from 'playwright';
import readline from 'node:readline';

const baseURL = ${JSON.stringify(baseUrl)};

let browser = null;
let context = null;
let page = null;
let lastSnapshot = null;
let pendingApiCalls = [];
let pendingConsoleErrors = [];
let pendingWebSocketMessages = [];

const MAX_CAPTURED_TEXT_CHARS = 2000;
const MAX_CAPTURED_PER_ACTION = 10;

// WebSocket frame payloads can be binary (Buffer) — not meaningful to
// stringify byte-for-byte, and a real-time app's meaningful traffic is
// virtually always a text/JSON frame anyway.
function payloadToText(payload) {
  if (typeof payload === 'string') return payload.slice(0, MAX_CAPTURED_TEXT_CHARS);
  return \`<binary frame, \${payload.length} bytes>\`;
}

async function ensureBrowser() {
  if (!browser) browser = await launchBrowser.launch();
  return browser;
}

async function ensurePage() {
  await ensureBrowser();
  if (!context) context = await browser.newContext({baseURL});
  if (!page) {
    page = await context.newPage();

    // Attached once per page (a fresh page is only ever created here, on
    // first use or after 'reset'), not per-action — draining happens in
    // actAndReport instead, so these listeners just accumulate into the
    // module-level arrays for whatever action is currently in flight.
    //
    // Scoped to xhr/fetch only, not every response — a page load pulls in
    // scripts, stylesheets, images, fonts; none of that is the "did my
    // data show up" question this exists to answer, and capturing all of
    // it would bury the one or two calls that actually matter.
    page.on('response', (response) => {
      if (pendingApiCalls.length >= MAX_CAPTURED_PER_ACTION) return;
      const resourceType = response.request().resourceType();
      if (resourceType !== 'xhr' && resourceType !== 'fetch') return;

      const status = response.status();
      pendingApiCalls.push({
        url: response.url(),
        status,
        statusText: response.statusText(),
        ok: status < 400,
        // Best-effort — not every response has a readable body (e.g. an
        // aborted request), and this must never throw past here.
        bodyPromise: response.text().catch(() => undefined),
      });
    });

    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      if (pendingConsoleErrors.length >= MAX_CAPTURED_PER_ACTION) return;
      pendingConsoleErrors.push(msg.text());
    });

    page.on('pageerror', (error) => {
      if (pendingConsoleErrors.length >= MAX_CAPTURED_PER_ACTION) return;
      pendingConsoleErrors.push(String(error));
    });

    // Fires once per WebSocket the page opens (reconnects create a new one
    // each time) — frame listeners are attached fresh per connection, same
    // as the page-level listeners above are attached once per page.
    page.on('websocket', (ws) => {
      const url = ws.url();

      ws.on('framesent', (frame) => {
        if (pendingWebSocketMessages.length >= MAX_CAPTURED_PER_ACTION) return;
        pendingWebSocketMessages.push({url, direction: 'sent', payload: payloadToText(frame.payload)});
      });

      ws.on('framereceived', (frame) => {
        if (pendingWebSocketMessages.length >= MAX_CAPTURED_PER_ACTION) return;
        pendingWebSocketMessages.push({url, direction: 'received', payload: payloadToText(frame.payload)});
      });
    });
  }
  return page;
}

// Drains whatever accumulated since the last call, resolving the deferred
// response bodies now (not eagerly in the listener, so a request that's
// still in flight when captured has a chance to finish first).
async function drainCapturedEvents() {
  const apiCalls = pendingApiCalls;
  const consoleErrors = pendingConsoleErrors;
  const webSocketMessages = pendingWebSocketMessages;
  pendingApiCalls = [];
  pendingConsoleErrors = [];
  pendingWebSocketMessages = [];

  const resolvedApiCalls = await Promise.all(
    apiCalls.map(async ({url, status, statusText, ok, bodyPromise}) => {
      const body = await bodyPromise;
      return {
        url,
        status,
        statusText,
        ok,
        body: body ? body.slice(0, MAX_CAPTURED_TEXT_CHARS) : undefined,
      };
    }),
  );

  return {
    apiCalls: resolvedApiCalls.length > 0 ? resolvedApiCalls : undefined,
    consoleErrors: consoleErrors.length > 0 ? consoleErrors : undefined,
    webSocketMessages: webSocketMessages.length > 0 ? webSocketMessages : undefined,
  };
}

async function snapshotOf(p) {
  return p.locator('body').ariaSnapshot();
}

// Best-effort settle before reading the DOM — actions that trigger an SPA
// route change or an async render have no navigation event to wait on, so
// this is a bounded-time nudge, not a guarantee. Never blocks longer than
// the timeout even if the page keeps background network activity forever.
async function settle(p) {
  await p.waitForLoadState('networkidle', {timeout: 2000}).catch(() => {});
  // 'networkidle' is a network-level signal (no in-flight connections) —
  // it can resolve slightly before a response's own .then()/catch handler
  // has actually run (that's a separate JS microtask, not tied to the
  // connection closing), which is exactly when a page's own error-handling
  // code logs to console. Confirmed live: without this, a failure fired by
  // a fetch's .then() callback sometimes only got captured on the NEXT
  // action instead of this one. Small and bounded, not a real wait.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function actAndReport(action) {
  const p = await ensurePage();
  // Cleared right before the action, not just drained after — anything
  // left over from a PREVIOUS action has already been reported once and
  // shouldn't reappear attached to this one.
  pendingApiCalls = [];
  pendingConsoleErrors = [];
  pendingWebSocketMessages = [];
  await action(p);
  await settle(p);
  const snapshot = await snapshotOf(p);
  const changed = snapshot !== lastSnapshot;
  lastSnapshot = snapshot;
  const {apiCalls, consoleErrors, webSocketMessages} = await drainCapturedEvents();
  return {
    ok: true,
    url: p.url(),
    title: await p.title(),
    changed,
    snapshot: changed ? snapshot : undefined,
    apiCalls,
    consoleErrors,
    webSocketMessages,
  };
}

async function handle(command) {
  switch (command.action) {
    case 'navigate':
      return actAndReport((p) => p.goto(command.url));
    case 'click':
      return actAndReport((p) => p.locator(command.selector).click());
    case 'fill':
      return actAndReport((p) => p.locator(command.selector).fill(command.value));
    case 'selectOption':
      return actAndReport((p) => p.locator(command.selector).selectOption({label: command.label}));
    case 'press':
      return actAndReport((p) =>
        command.selector
          ? p.locator(command.selector).press(command.key)
          : p.keyboard.press(command.key)
      );
    case 'hover':
      return actAndReport((p) => p.locator(command.selector).hover());
    case 'wait':
      return actAndReport((p) =>
        p.locator(command.selector).waitFor({state: command.state, timeout: 10000})
      );
    case 'snapshot': {
      const p = await ensurePage();
      const snapshot = await snapshotOf(p);
      lastSnapshot = snapshot;
      // Drained here too, not just in actAndReport — otherwise anything
      // that happened between the last action and this snapshot (e.g. an
      // async request that only failed after the page had already
      // settled) would sit uncleared until the NEXT action's actAndReport
      // silently wipes it before it was ever reported.
      const {apiCalls, consoleErrors, webSocketMessages} = await drainCapturedEvents();
      return {ok: true, url: p.url(), title: await p.title(), snapshot, apiCalls, consoleErrors, webSocketMessages};
    }
    case 'reset': {
      await ensureBrowser();
      if (context) await context.close();
      context = await browser.newContext({baseURL});
      page = null;
      lastSnapshot = null;
      // These are module-level, not tied to the page object itself, so
      // closing the context doesn't clear them on its own — anything
      // captured on the old page must not leak into the new one's first
      // action.
      pendingApiCalls = [];
      pendingConsoleErrors = [];
      pendingWebSocketMessages = [];
      return {ok: true};
    }
    case 'close': {
      if (browser) await browser.close();
      return {ok: true};
    }
    default:
      return {ok: false, error: \`Unknown action: \${command.action}\`};
  }
}

const rl = readline.createInterface({input: process.stdin});

rl.on('line', async (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ok: false, error: 'Invalid JSON command'}) + '\\n');
    return;
  }

  try {
    const response = await handle(command);
    process.stdout.write(JSON.stringify(response) + '\\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ok: false, error: error instanceof Error ? error.message : String(error)}) + '\\n');
  }

  if (command.action === 'close') {
    process.exit(0);
  }
});
`;
}

// Strictly sequential request/response over stdin/stdout — safe because the
// agent loop only ever awaits one tool call at a time, so there's never more
// than one in-flight command to correlate.
export function spawnBrowserWorker(
	projectRoot: string,
	defaultBrowser: string,
	baseUrl: string,
): BrowserWorkerHandle {
	const indexDir = path.join(projectRoot, '.orbit', 'index');
	fs.mkdirSync(indexDir, {recursive: true});

	const workerPath = path.join(indexDir, 'browser-worker.mjs');
	fs.writeFileSync(
		workerPath,
		buildBrowserWorkerSource(resolveBrowserName(defaultBrowser), baseUrl),
		'utf8',
	);

	const child = spawn(process.execPath, [workerPath], {
		cwd: projectRoot,
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	const rl = readline.createInterface({input: child.stdout});
	const pending: Array<(response: BrowserWorkerResponse) => void> = [];

	rl.on('line', line => {
		const resolve = pending.shift();
		if (!resolve) return;

		try {
			resolve(JSON.parse(line) as BrowserWorkerResponse);
		} catch {
			resolve({ok: false, error: 'Malformed response from browser worker'});
		}
	});

	let dead = false;
	child.on('exit', () => {
		dead = true;
		while (pending.length > 0) {
			pending.shift()?.({
				ok: false,
				error: 'Browser worker exited unexpectedly',
			});
		}
	});
	child.on('error', () => {
		dead = true;
	});

	return {
		async send(command) {
			if (dead) {
				return {
					ok: false,
					error: 'Browser worker is no longer running',
				};
			}

			return new Promise(resolve => {
				pending.push(resolve);
				child.stdin.write(JSON.stringify(command) + '\n');
			});
		},
		isAlive: () => !dead,
		close() {
			if (dead) return;

			try {
				child.stdin.write(
					JSON.stringify({action: 'close'} satisfies BrowserWorkerCommand) +
						'\n',
				);
			} catch {
				// Already gone — nothing to signal.
			}

			// Hard-kill fallback in case the worker doesn't exit on its own.
			setTimeout(() => {
				if (!dead) child.kill();
			}, 2000);
		},
	};
}
