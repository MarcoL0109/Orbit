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
* Answers plain questions about the project directly — no `/command` needed — reading real code and, with your approval, running a real `/test` when you actually want one
* Runs headlessly from a CI pipeline (`--ci`) — same agent, no interactive prompts, exits with a pass/fail status code
* Tests an already-running app it has no source access to at all (**blind mode**) — pure live-browser exploration, in a workspace of its own, for cases where reading the codebase isn't an option

Every file write, shell command, and test run is approval-gated by default — you see exactly what Orbit is about to do before it does it.

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/orbit.git
cd orbit
./install.sh
```

This installs dependencies, builds the CLI, and adds `orbit` to your `PATH` (via `~/.orbit/bin`). Restart your terminal, then run `orbit` from inside any project.

You'll need an OpenAI API key. `install.sh` prompts for one interactively (input is hidden) and persists it as `export OPENAI_API_KEY="..."` in your shell profile — skipped automatically if the key's already set or already configured from a previous install. If you skip the prompt, set it yourself:

```bash
export OPENAI_API_KEY="your_key_here"
```

(A `.env` file in Orbit's own directory also works, but only when running Orbit's source directly during development — not for the installed CLI or CI use, both of which need a real exported environment variable.)

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
| `/init [path]` | Create `.orbit/` context and run an initial scan — confirms the detected path first, or trusts an explicit one directly |
| `/test <description>` | Generate and run a Playwright test for the feature you describe |
| `/scan` | Refresh the project index (routes, components, tests, config) |
| `/coverage` | List routes/components with no matching test |
| `/config` | Allow user to switch their Orbit settings via terminal (also supports direct file modifications) |
| `/memory [--overview] [--decisions] [--env] [--failures]` | Show project memory — no flags shows all three sections, flags filter to just what you ask for |
| `/projects` | Show every project Orbit has been initialized in |
| `/switch` | Switch Orbit to a different project |
| `/abort` | Abort the current running task |
| `/deinit` | Remove `.orbit/` context and forget the project |
| `/clear` | Clear the terminal screen |
| `/help` | List available commands |
| `/exit` | Exit Orbit, cleaning up any process it started itself |

`/init`'s project-root auto-detection scores a directory by the config files it finds (`package.json`, `next.config.*`, `.git`, ...) and requires a minimum confidence before trusting it — which a polyglot monorepo can fail even when the actual app lives right there, if its root has no JS-specific marker (a Python backend alongside a `frontend/` folder, for example). A bare `/init` (no path) shows you what it detected — or plain `cwd` if it couldn't detect anything — and asks you to confirm it; press Enter to accept it, or edit it first to redirect Orbit somewhere else (like `frontend`) before confirming. `/init <path>` given directly skips that confirmation and trusts the path outright, bypassing the scoring entirely — useful once you already know where Orbit should init. Since playwright binary and chromium is needed. If those are missing when init, Orbit will ask whether you wish to install playwright and chromium.

## How `/test` actually works

`/test` runs an agent loop backed by GPT-5.2 with a fixed set of tools:

* **`read_file`** — read a file relative to the project root
* **`explain_symbol`** — look up a function, component, or file in the project's knowledge graph and see exactly what it calls, what calls it, and what imports it, without opening the file (only available in graphify scan mode — see below)
* **`browser_action`** — drive a real, persistent Playwright browser: navigate, click, fill, select an option from a native `<select>`, press a keyboard key (scoped to a focused element or sent globally), hover, wait for an element to become visible or disappear, snapshot the accessibility tree, or reset to a clean session. Every response also carries any failed network requests (with status and body) and console errors that happened during that action, so the agent can tell a real backend bug apart from its own bad selector instead of guessing from a blank screen. Every selector, key press, and dropdown choice it confirms actually works live gets carried forward and handed back to it before it writes the test file — so `write_test_file` reuses what was verified against the real page instead of reconstructing something similar-looking from memory
* **`write_test_file`** — write a Playwright spec into your configured test directory
* **`run_test`** — run a spec (or the whole suite) and get back structured pass/fail results
* **`request_user_input`** — ask you directly for something it has no way to obtain itself (a code sent by email, a secret only you have). It only asks after it has already tried exploring live with the browser first, and a feature that needed this is recorded as verified-but-not-automated rather than turned into a test that would silently repeat a real side effect (like re-sending an email) every time it ran
* **`report_result`** — report one pass/fail result per feature, with a summary. A failed or given-up result also needs a `rootCause`: the specific, evidence-backed reason it failed — not a restatement of the summary — which gets written to `.orbit/memory/failures.md` so the *next* run against this project starts already knowing about it, instead of rediscovering the same failure cold. Each result also breaks down where the pipeline actually stood, not just whether it passed overall: whether live browser exploration itself worked, whether the real backend response for whatever the feature creates/saves/submits was actually checked and confirmed (not just inferred from the UI looking fine), and whether the written Playwright test passed — that last one alone is never self-reported, it's read directly from the real test run's own result

Before writing a fix, the agent reads real markup and watches the real page, not just the source — and it's told explicitly to tell a genuine application bug apart from its own mistake using the browser's network/console evidence, rather than inferring one from silence. A repair budget (`maxRepairAttempts`, default 3) caps how many times it'll patch a failing test before giving up and reporting the feature as failed.

## Asking Orbit questions

Type a plain question instead of a `/command` and Orbit answers it directly — grounded in what it can actually find out about the project, not a guess. This is a separate, smaller agent from `/test`'s: it never writes or runs a test on its own initiative, and its own tools reflect that:

* **`read_file`** / **`explain_symbol`** — the same code-exploration tools `/test` uses
* **`check_memory`** — the same content `/memory` shows
* **`check_coverage`** — the same report `/coverage` shows
* **`refresh_project_scan`** — refreshes the project index (and the knowledge graph, if this project already uses graphify) — the non-interactive part of what `/scan` does
* **`run_test_command`** — the real `/test`: writes and runs a real Playwright test against the live app. The one exception to "never writes or runs on its own" — every single call asks for your approval first, with no way around it, so it only ever happens when you actually mean it to

The first four are read-only and never prompt. Ask it things like *"how does authentication work here?"*, *"what's not covered yet?"*, or *"why did the last test fail?"* — it reads source, checks the knowledge graph (if available), or reaches for one of the commands above as needed, then answers in its own words instead of dumping raw output back at you.

Press Tab on an empty prompt to accept a recommended next question — generated fresh from the project's actual current state (a recent test failure worth digging into, an obvious coverage gap, or a natural first question for a brand-new project with no history yet), the same way Tab completes a partially-typed `/command` name.

## Starting your dev environment automatically

If your app isn't already reachable at the configured `baseUrl` when you run `/test`, Orbit brings it up itself before testing anything — a separate agent reads your README/config files (or `.orbit/memory/environment_setup.md`, if you've written one) and runs whatever shell commands are needed (`docker compose up`, migrations, dev servers), asking your approval for every single command first. It never trusts its own "I think it's ready" — reachability is independently re-verified afterward.

The first time it has to work this out from scratch, it writes down what it learned to `.orbit/memory/environment_setup.md`, so the next session's first `/test` doesn't have to rediscover it. If you'd rather write that file yourself, Orbit will pause and give you the chance before it starts guessing — your instructions are always followed directly, and it still repairs its own way through anything that turns out to be wrong or incomplete in them.

Orbit brings infrastructure up but never tears it down on its own — it's left running for reuse across multiple `/test` runs in the same session. Run `docker compose down` yourself when you're done with it.

## Scanning strategy

Every `/test` and `/scan` keeps a project index fresh. There are two scan modes, chosen once per project (the choice is remembered — you're only asked the first time):

* **Regex** — a fast, dependency-free heuristic scan: walks the file tree, classifies files by role (route, component, test, config, ...), and detects Next.js/SvelteKit/Remix-style routes by filename convention. Always available.
* **Graphify** — builds an actual AST-based code knowledge graph via [graphify](https://github.com/Graphify-Labs/graphify) (tree-sitter under the hood, no LLM calls for the base extraction). This is what powers the `explain_symbol` tool. If graphify isn't installed when you pick this mode, Orbit offers to install it (`uv`/`pipx`/`pip`, whichever's available) — with your approval first.

Either way, the regular scan still runs — graphify mode adds to it, it never replaces it.

## CI mode

```bash
orbit "user can sign up" --ci
```

Runs the exact same testing agent headlessly — no interactive UI, no prompts — and exits with a status code a pipeline can gate on: `0` if every feature passed, `1` if the agent ran but a feature failed, `2` if it couldn't run at all (bad project, misconfigured, unreachable, or the run was cancelled). The description must be a single quoted argument — an unquoted multi-word description arrives as separate words with no way to tell it apart from several arguments, so `--ci` rejects it with a corrected example rather than guessing.

Add `--json` for a machine-parseable result instead of human-readable text:

```bash
orbit "user can sign up" --ci --json
```

```json
{
  "status": "passed",
  "summary": "Test passed: 1/1 feature(s) passed",
  "features": [
    {
      "feature": "auth.signup",
      "file": "auth.signup.spec.ts",
      "status": "passed",
      "summary": "New user can sign up and reaches the dashboard.",
      "requiresManualInput": false,
      "manualStepOutcome": null,
      "tests": {
        "totalTests": 1,
        "passedCount": 1,
        "failedCount": 0,
        "durationMs": 6421,
        "attempts": 1,
        "tests": [{ "title": "user can sign up", "status": "passed", "durationMs": 6421 }],
        "failures": []
      }
    }
  ],
  "exitCode": 0
}
```

Exactly one JSON object is written to stdout — the process's normal exit code still applies, but `exitCode` is repeated inside the object too so a consumer parsing captured stdout doesn't also need to separately track how the process exited. Everything else that would normally print (per-step progress, the graphify outcome, an auto-resolved-uncertain-outcome note, the human-readable summary) moves to stderr instead, so stdout is safe to pipe straight into `JSON.parse`. A pre-flight failure (bad project, wrong approval mode, unreachable) still produces one JSON object, shaped as `{"status": "error", "error": "...", "exitCode": 2}`, rather than leaving stdout empty. `--json` without `--ci` is rejected — it only means anything paired with a headless run.

Three things CI mode deliberately does *not* do, unlike interactive `/test`:

* **Won't run with `approvalMode`/`writeMode` still `"ask"`.** There's no human to answer an approval prompt in a pipeline — set both to `"always"` first via `/config` (interactively, once), or `--ci` refuses to start.
* **Won't auto-start your dev environment.** It only checks `baseUrl` is already reachable and fails clearly if not — bring your app up in an earlier pipeline step, the same way CI conventionally does. (Interactive `/test`'s auto-setup agent runs arbitrary shell commands to discover a startup sequence; that's a different risk profile in an unattended CI runner than on your own machine.)
* **Won't let an uncertain result pass silently.** If the agent can't confidently tell whether something worked (interactively, this is what `confirm_outcome` asks you about), CI mode auto-resolves it as a failure — clearly logged as auto-resolved, not silently swallowed — rather than optimistically letting an unconfirmed result go green.

CI-generated tests are written to their own `.orbit/orbit-ci/` folder — kept separate from the interactive `testDir` (`Orbit-test/e2e` by default) so a pipeline run never mixes its output in with tests you wrote or reviewed by hand, and kept out of your source tree since they're regenerated fresh on every run rather than something to review or commit.

Example GitHub Actions step:

```yaml
- name: Run Orbit test
  run: orbit "user can sign up" --ci
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Orbit doesn't generate or manage this file itself — `--ci` just gives any CI system (GitHub Actions, GitLab CI, Jenkins, ...) a normal exit-code contract to run against.

## Blind mode

For a project Orbit shouldn't read at all — not "won't," structurally can't. Blind mode explores an already-running app purely through a live browser, from a workspace Orbit creates for itself outside the app's own directory. `read_file` and `explain_symbol` aren't just discouraged in this mode, they're removed from the tool set entirely — the model has no way to call them even if it tried. There's no project scan, either, and Orbit never tries to bring the app up itself if it isn't reachable: a blind project has no source for a setup agent to discover a startup sequence from, so an unreachable target fails fast with a clear message instead of guessing.

Enter it from `/config` — select **Blind mode** and give it the app's URL — or, if no project is active yet, from the project picker's **Set Up Blind Project** option (offered alongside "Add New Project"). Either way:

1. The URL is checked for reachability twice: once the moment you enter it (before anything is shown or created), and again right before the workspace is actually written to disk. A target that's unreachable — or goes unreachable in the gap between typing the URL and confirming the storage path — never leaves a workspace behind.
2. If the URL is already known, Orbit switches straight to that project — no re-prompting, no re-creating anything.
3. Otherwise you're shown a suggested storage path (`~/Orbit/<name>`, derived from the URL's host and port) to confirm or edit before anything is created.
4. Playwright installs directly into that workspace — it never depends on (or touches) any `node_modules` belonging to the actual app, since blind mode assumes there may be no local copy of the app to depend on at all.

A blind workspace's own Orbit folder is named `orbit`, not `.orbit`. A normal project keeps the dot so the folder reads as "tool state, not your code" next to real source — a blind workspace has nothing else in it to distinguish itself from, so hiding it the same way would just bury the one thing this mode is supposed to make easy to inspect.

There's no way to turn blind mode "off" on a project in place — a workspace with no real source can't become a normal one by flipping a config bit. Selecting **Blind mode** again from `/config` while already on a blind project opens the project picker instead, the same way `/switch` does — that's the actual way out.

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
  orbit-ci/               # tests written by --ci runs, regenerated fresh each time
```

`graphify-out/` (graph.json, GRAPH_REPORT.md, etc.) is written at your project root, not inside `.orbit/`, since that's where graphify's own incremental caching expects it to live — Orbit adds it to your `.gitignore` automatically.

Run `/memory` to read `overview.md`, `decisions.md`, `environment_setup.md` and `failures.md` back in the terminal instead of opening them by hand — pass `--overview`, `--decisions`, `--env` and/or `--failures` to see only some of them; with no flags it shows all three.

This layout, folder name included, is specific to a normal project. A [blind-mode](#blind-mode) workspace uses the exact same structure under a folder named `orbit` instead of `.orbit` — see that section for why.

### Configuration (`.orbit/config.json`)

```json
{
  "approvalMode": "ask",
  "defaultBrowser": "chromium",
  "baseUrl": "http://localhost:3000",
  "devCommands": [],
  "testCommand": null,
  "testDir": "Orbit-test/e2e",
  "manualTestDir": "Orbit-test/user_input_test",
  "writeMode": "ask",
  "maxRepairAttempts": 3,
  "dockerComposeFile": null,
  "dockerComposeHasHealthchecks": false,
  "scanMode": null,
  "environmentSetupRoot": null
}
```

`baseUrl` and `dockerComposeFile` are auto-detected at `/init`. `scanMode` starts `null` (not yet chosen) and gets set the first time you pick regex or graphify. `manualTestDir` holds human-readable `.md` records for features that needed `request_user_input` — never a runnable test, since there's nothing safe to automate for those.

`environmentSetupRoot` matters only when your project's root is itself a subdirectory of a larger repo — a JS frontend with a sibling backend, `docker-compose.yml`, and README one level up, for instance. `read_file` and `run_command` are both sandboxed to the project root everywhere else in Orbit, which is exactly right for writing/running tests (that's where `node_modules/.bin/playwright` and `testDir` actually live) — but it means the environment-setup agent, run from that same root, has no way to even discover a sibling backend exists, let alone start it. Set `environmentSetupRoot` to the repo root (via `/config`) to widen *only* the setup agent's own view; everything else (scanning, `write_test_file`, `run_test`) keeps using the project root unchanged. Leave it `null` when your project root already is the repo root, which is the common case.

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

Every file write, shell command, and destructive test-environment action is gated behind an explicit approval prompt by default (`approvalMode`/`writeMode: "ask"`) — you see exactly what's about to run and why before it happens. Orbit never classifies a shell command as "safe" or "dangerous" by its text — that judgment isn't reliable to automate, so every command gets the same approval gate regardless of what it looks like. Orbit never reads `.env` file contents, and never stores API keys, passwords, tokens, or real user data in its own memory files. Plain-question mode's `run_test_command` tool always asks for approval too — unconditionally, not just when `approvalMode` is `"ask"` — since it's the one way that mode can write a file or touch the live app at all.

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
