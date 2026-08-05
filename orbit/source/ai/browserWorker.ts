import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export type BrowserWorkerCommand =
    | {action: 'navigate'; url: string}
    | {action: 'click'; selector: string}
    | {action: 'fill'; selector: string; value: string}
    | {action: 'snapshot'}
    | {action: 'reset'}
    | {action: 'close'};

export type BrowserWorkerResponse =
    | {ok: true; url?: string; title?: string; changed?: boolean; snapshot?: string}
    | {ok: false; error: string};

export type BrowserWorkerHandle = {
    send: (command: BrowserWorkerCommand) => Promise<BrowserWorkerResponse>;
    isAlive: () => boolean;
    close: () => void;
};

const VALID_BROWSERS = new Set(['chromium', 'firefox', 'webkit']);

function resolveBrowserName(defaultBrowser: string): 'chromium' | 'firefox' | 'webkit' {
    return VALID_BROWSERS.has(defaultBrowser) ? (defaultBrowser as 'chromium' | 'firefox' | 'webkit') : 'chromium';
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
function buildBrowserWorkerSource(browserName: 'chromium' | 'firefox' | 'webkit', baseUrl: string): string {
    return `import { ${browserName} as launchBrowser } from 'playwright';
import readline from 'node:readline';

const baseURL = ${JSON.stringify(baseUrl)};

let browser = null;
let context = null;
let page = null;
let lastSnapshot = null;

async function ensureBrowser() {
  if (!browser) browser = await launchBrowser.launch();
  return browser;
}

async function ensurePage() {
  await ensureBrowser();
  if (!context) context = await browser.newContext({baseURL});
  if (!page) page = await context.newPage();
  return page;
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
}

async function actAndReport(action) {
  const p = await ensurePage();
  await action(p);
  await settle(p);
  const snapshot = await snapshotOf(p);
  const changed = snapshot !== lastSnapshot;
  lastSnapshot = snapshot;
  return {
    ok: true,
    url: p.url(),
    title: await p.title(),
    changed,
    snapshot: changed ? snapshot : undefined,
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
    case 'snapshot': {
      const p = await ensurePage();
      const snapshot = await snapshotOf(p);
      lastSnapshot = snapshot;
      return {ok: true, url: p.url(), title: await p.title(), snapshot};
    }
    case 'reset': {
      await ensureBrowser();
      if (context) await context.close();
      context = await browser.newContext({baseURL});
      page = null;
      lastSnapshot = null;
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
export function spawnBrowserWorker(projectRoot: string, defaultBrowser: string, baseUrl: string): BrowserWorkerHandle {
    const indexDir = path.join(projectRoot, '.orbit', 'index');
    fs.mkdirSync(indexDir, {recursive: true});

    const workerPath = path.join(indexDir, 'browser-worker.mjs');
    fs.writeFileSync(workerPath, buildBrowserWorkerSource(resolveBrowserName(defaultBrowser), baseUrl), 'utf8');

    const child = spawn(process.execPath, [workerPath], {cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe']});

    const rl = readline.createInterface({input: child.stdout});
    const pending: Array<(response: BrowserWorkerResponse) => void> = [];

    rl.on('line', (line) => {
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
            pending.shift()?.({ok: false, error: 'Browser worker exited unexpectedly'});
        }
    });
    child.on('error', () => {
        dead = true;
    });

    return {
        send: (command) => {
            if (dead) {
                return Promise.resolve({ok: false, error: 'Browser worker is no longer running'});
            }

            return new Promise((resolve) => {
                pending.push(resolve);
                child.stdin.write(JSON.stringify(command) + '\n');
            });
        },
        isAlive: () => !dead,
        close: () => {
            if (dead) return;

            try {
                child.stdin.write(JSON.stringify({action: 'close'} satisfies BrowserWorkerCommand) + '\n');
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
