# Orbit

Orbit is an interactive terminal AI QA agent. Point it at a project, describe a feature in plain English, and it writes a real Playwright test for it, runs the test, repairs it if the selectors were wrong, and tells you whether the feature actually works — reading source, exploring with a real browser, and starting your dev environment for you along the way.

```txt
🪐 Orbit
AI QA agent for project scanning, test planning, and E2E automation
```

## What Orbit does

* Detects and initializes a project, remembering it globally
* Scans the codebase for routes, components, tests, and configuration
* Writes and runs Playwright E2E tests for a feature you describe in plain English
* Explores your app live in a real browser to ground tests in what actually renders, not just what the source implies
* Starts your dev environment itself — Docker, migrations, dev servers — when it isn't already running
* Distinguishes a real application bug from its own test-writing mistake, using the actual network/console evidence, not a guess
* Repairs a broken test automatically, but stops and reports a real bug instead of endlessly patching around one
* Asks for your help on anything it has no way to do itself (a 2FA code, an email verification link)
* Keeps a per-project knowledge graph (optional, via [graphify](https://github.com/Graphify-Labs/graphify)) so it can understand how code connects without opening every file
* Tracks feature coverage — which routes and components have a matching test and which don't

Every file write, shell command, and test run is approval-gated by default — you see exactly what Orbit is about to do before it does it.

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/orbit.git
cd orbit
./install.sh
```

This installs dependencies, builds the CLI, and adds `orbit` to your `PATH` (via `~/.orbit/bin`). Restart your terminal, then run `orbit` from inside any project.

You'll need an OpenAI API key — either exported as `OPENAI_API_KEY`, or in a `.env` file in Orbit's own directory during development.

## Quick start

```bash
cd ~/Documents/GitHub/your-app
orbit
```

```txt
/init
```

Detects your framework, package manager, and test setup; scans the project; and remembers it globally.

```txt
/test the login flow
```

Orbit figures out how to bring your dev environment up if it isn't already running, explores the login page with a real browser, writes a Playwright test, runs it, and reports what passed and what didn't.

```txt
/coverage
```

Shows which routes and components still have no test at all.

## Commands

| Command | What it does |
|---|---|
| `/init` | Create `.orbit/` context for the current project and run an initial scan |
| `/test <description>` | Generate and run a Playwright test for the feature you describe |
| `/scan` | Refresh the project index (routes, components, tests, config) |
| `/coverage` | List routes/components with no matching test |
| `/projects` | Show every project Orbit has been initialized in |
| `/switch` | Switch Orbit to a different project |
| `/abort` (aliases: `/cancel`, `/stop`) | Abort the current running task |
| `/deinit` | Remove `.orbit/` context and forget the project |
| `/clear` | Clear the terminal screen |
| `/help` | List available commands |
| `/exit` | Exit Orbit, cleaning up any process it started itself |

## How `/test` actually works

`/test` runs an agent loop backed by GPT-5.2 with a fixed set of tools:

* **`read_file`** — read a file relative to the project root
* **`explain_symbol`** — look up a function, component, or file in the project's knowledge graph and see exactly what it calls, what calls it, and what imports it, without opening the file (only available in graphify scan mode — see below)
* **`browser_action`** — drive a real, persistent Playwright browser: navigate, click, fill, snapshot the accessibility tree, or reset to a clean session. Every response also carries any failed network requests (with status and body) and console errors that happened during that action, so the agent can tell a real backend bug apart from its own bad selector instead of guessing from a blank screen
* **`write_test_file`** — write a Playwright spec into your configured test directory
* **`run_test`** — run a spec (or the whole suite) and get back structured pass/fail results
* **`request_user_input`** — ask you directly for something it has no way to obtain itself (a code sent by email, a secret only you have). It only asks after it has already tried exploring live with the browser first, and a feature that needed this is recorded as verified-but-not-automated rather than turned into a test that would silently repeat a real side effect (like re-sending an email) every time it ran
* **`report_result`** — report one pass/fail result per feature, with a summary

Before writing a fix, the agent reads real markup and watches the real page, not just the source — and it's told explicitly to tell a genuine application bug apart from its own mistake using the browser's network/console evidence, rather than inferring one from silence. A repair budget (`maxRepairAttempts`, default 3) caps how many times it'll patch a failing test before giving up and reporting the feature as failed.

## Starting your dev environment automatically

If your app isn't already reachable at the configured `baseUrl` when you run `/test`, Orbit brings it up itself before testing anything — a separate agent reads your README/config files (or `.orbit/memory/environment_setup.md`, if you've written one) and runs whatever shell commands are needed (`docker compose up`, migrations, dev servers), asking your approval for every single command first. It never trusts its own "I think it's ready" — reachability is independently re-verified afterward.

The first time it has to work this out from scratch, it writes down what it learned to `.orbit/memory/environment_setup.md`, so the next session's first `/test` doesn't have to rediscover it. If you'd rather write that file yourself, Orbit will pause and give you the chance before it starts guessing — your instructions are always followed directly, and it still repairs its own way through anything that turns out to be wrong or incomplete in them.

Orbit brings infrastructure up but never tears it down on its own — it's left running for reuse across multiple `/test` runs in the same session. Run `docker compose down` yourself when you're done with it.

## Scanning strategy

Every `/test` and `/scan` keeps a project index fresh. There are two scan modes, chosen once per project (the choice is remembered — you're only asked the first time):

* **Regex** — a fast, dependency-free heuristic scan: walks the file tree, classifies files by role (route, component, test, config, ...), and detects Next.js/SvelteKit/Remix-style routes by filename convention. Always available.
* **Graphify** — builds an actual AST-based code knowledge graph via [graphify](https://github.com/Graphify-Labs/graphify) (tree-sitter under the hood, no LLM calls for the base extraction). This is what powers the `explain_symbol` tool. If graphify isn't installed when you pick this mode, Orbit offers to install it (`uv`/`pipx`/`pip`, whichever's available) — with your approval first.

Either way, the regular scan still runs — graphify mode adds to it, it never replaces it.

## `.orbit/` — per-project context

```txt
<project>/.orbit/
  project.json          # name, root, framework, package manager, test framework
  config.json            # see Configuration below
  index/
    project-map.json     # routes, components, tests, config files — from the last /scan
    checksums.json        # used to skip re-scanning unchanged files
    browser-worker.mjs    # generated Playwright worker script (regenerated each run)
  memory/
    overview.md            # project notes, edit freely
    decisions.md            # testing conventions Orbit should follow
    failures.md              # known failure patterns
    environment_setup.md      # exact dev-environment startup steps, yours or self-discovered
  sessions/               # one JSON record per /test run
  traces/
```

`graphify-out/` (graph.json, GRAPH_REPORT.md, etc.) is written at your project root, not inside `.orbit/`, since that's where graphify's own incremental caching expects it to live — Orbit adds it to your `.gitignore` automatically.

### Configuration (`.orbit/config.json`)

```json
{
  "approvalMode": "ask",
  "defaultBrowser": "chromium",
  "baseUrl": "http://localhost:3000",
  "devCommands": [],
  "testCommand": null,
  "testDir": "Orbit_test/e2e",
  "manualTestDir": "Orbit_test/user_input_test",
  "writeMode": "ask",
  "maxRepairAttempts": 3,
  "dockerComposeFile": null,
  "dockerComposeHasHealthchecks": false,
  "scanMode": null
}
```

`baseUrl` and `dockerComposeFile` are auto-detected at `/init`. `scanMode` starts `null` (not yet chosen) and gets set the first time you pick regex or graphify. `manualTestDir` holds human-readable `.md` records for features that needed `request_user_input` — never a runnable test, since there's nothing safe to automate for those.

## `~/.orbit/` — global context

```txt
~/.orbit/
  bin/orbit               # the installed executable
  config.json               # version, approvalMode, defaultBrowser, defaultModel, telemetry, lastOpenedProject
  projects.json               # every project Orbit has been initialized in
  memory/preference.md          # your own QA preferences, editable
```

`projects.json` entries carry name, path, framework, package manager, test framework, and usage stats (`lastOpenedAt`, `lastScannedAt`, `openCount`) — enough for `/projects` and `/switch` to work without rescanning everything.

## Safety model

Every file write, shell command, and destructive test-environment action is gated behind an explicit approval prompt by default (`approvalMode`/`writeMode: "ask"`) — you see exactly what's about to run and why before it happens. Orbit never classifies a shell command as "safe" or "dangerous" by its text — that judgment isn't reliable to automate, so every command gets the same approval gate regardless of what it looks like. Orbit never reads `.env` file contents, and never stores API keys, passwords, tokens, or real user data in its own memory files.

## Development

```bash
npm install
npm run dev      # tsx source/cli.tsx
npm run build    # tsup source/cli.tsx --format esm --out-dir dist
npm start         # node dist/cli.js
```

## Philosophy

* Terminal-first, project-aware, safe by default
* Human-readable memory — plain Markdown, editable by hand
* AI-assisted, not AI-dependent: the deterministic regex scan works with zero AI calls; AI (and the optional knowledge graph) make Orbit sharper without becoming a hard dependency
* Every AI belief — environment readiness, a passing test, a "bug" — is independently re-verified, never taken on its own word
