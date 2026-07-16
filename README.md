# Orbit

Orbit is an interactive CLI AI QA agent for scanning projects, understanding application structure, and helping generate, run, and improve end-to-end tests.

It is designed to work from your terminal, inside your project directory, with a focus on Playwright-based E2E testing.

```txt
🪐 Orbit
AI QA agent for project scanning, test planning, and E2E automation
```

## What Orbit Does

Orbit helps developers:

* Detect and initialize a project
* Create local Orbit context in `.orbit/`
* Scan source files, routes, commands, tests, configs, and project structure
* Remember initialized projects globally
* Use AI to reason about testing tasks
* Generate practical E2E testing ideas
* Maintain project-specific QA memory
* Refresh project context when the codebase changes

Orbit is built as a terminal-first tool, similar in spirit to coding agents like Claude Code, but focused on QA workflows.

## Installation

Clone the repository:

```bash
git clone https://github.com/YOUR_USERNAME/orbit.git
cd orbit
```

Install dependencies:

```bash
npm install
```

Build the CLI:

```bash
npm run build
```

Run the installer:

```bash
./install.sh
```

After installation, Orbit can be run from anywhere:

```bash
orbit
```

During development, run Orbit directly with:

```bash
npm run dev
```

## Global Orbit Directory

Orbit creates a global home directory at:

```txt
~/.orbit/
```

This stores user-level Orbit data.

Example structure:

```txt
~/.orbit/
  bin/
    orbit
  config.json
  projects.json
  memory/
    preferences.md
  logs/
  cache/
  tmp/
```

### `~/.orbit/bin/`

Contains the global `orbit` executable wrapper.

### `~/.orbit/config.json`

Stores global Orbit settings.

Example:

```json
{
  "version": 1,
  "approvalMode": "ask",
  "defaultBrowser": "chromium",
  "defaultModel": "gpt-5.2",
  "telemetry": false,
  "lastOpenedProject": null
}
```

### `~/.orbit/projects.json`

Stores initialized projects remembered by Orbit.

Initial content:

```json
{
  "projects": []
}
```

After projects are initialized, it may look like:

```json
{
  "projects": [
    {
      "name": "shop-app",
      "path": "/Users/marcolau/Documents/GitHub/shop-app",
      "framework": "Next.js",
      "packageManager": "pnpm",
      "testFramework": "Playwright",
      "lastOpenedAt": "2026-07-14T10:36:00.000Z",
      "lastScannedAt": "2026-07-14T10:36:00.000Z",
      "openCount": 1
    }
  ]
}
```

## Local Project Orbit Directory

When Orbit is initialized inside a project, it creates:

```txt
<project>/.orbit/
```

Example:

```txt
project/
  .orbit/
    project.json
    config.json
    index/
      project-map.json
      checksums.json
    memory/
      overview.md
      decisions.md
      failures.md
      generated-overview.md
    sessions/
    reports/
    traces/
```

### `.orbit/project.json`

Stores local project identity.

```json
{
  "name": "shop-app",
  "root": "/Users/marcolau/Documents/GitHub/shop-app",
  "framework": "Next.js",
  "packageManager": "pnpm",
  "testFramework": "Playwright",
  "createdAt": "2026-07-14T10:36:00.000Z",
  "updatedAt": "2026-07-14T10:36:00.000Z"
}
```

### `.orbit/config.json`

Stores project-specific Orbit settings.

```json
{
  "approvalMode": "ask",
  "defaultBrowser": "chromium",
  "baseUrl": "http://localhost:3000",
  "devCommand": null,
  "testCommand": null,
  "testDir": "tests/e2e",
  "writeMode": "ask",
  "maxRepairAttempts": 3
}
```

### `.orbit/index/`

Stores generated project indexes.

These files are rebuildable and can be refreshed with `/scan`.

### `.orbit/memory/`

Stores human-readable QA memory.

These files are intended to be editable and compatible with Markdown tools such as Obsidian.

## Commands

Orbit supports slash commands inside the interactive terminal.

### `/help`

Show available Orbit commands.

```txt
/help
```

### `/init`

Initialize Orbit in the current project.

```txt
/init
```

The init flow:

1. Confirms the project name
2. Creates missing `.orbit/` files
3. Runs an initial deterministic scan
4. Writes `.orbit/index/project-map.json`
5. Adds the project to `~/.orbit/projects.json`

If `.orbit/` already exists, Orbit will not overwrite user-editable files by default.

### `/scan`

Refresh the current project index.

```txt
/scan
```

The scan command:

* Walks relevant project files
* Ignores generated folders like `node_modules`, `.git`, `dist`, `build`, `.next`, and `.orbit`
* Detects framework, package manager, and test framework
* Classifies files as routes, components, commands, AI files, tests, configs, utilities, and project logic
* Writes the result to:

```txt
.orbit/index/project-map.json
```

### `/projects`

Show projects remembered by Orbit.

```txt
/projects
```

This reads:

```txt
~/.orbit/projects.json
```

### `/abort`

Abort the current running task.

```txt
/abort
```

Aliases:

```txt
/cancel
/stop
```

This is useful for stopping an AI request, scan, or other long-running operation.

### `/deinit`

Remove Orbit context from the current project.

```txt
/deinit
```

Recommended behavior:

* Move local `.orbit/` to a backup folder
* Remove the project from `~/.orbit/projects.json`
* Update the current TUI project state

Example:

```txt
.orbit
→ .orbit.deleted-2026-07-14T10-36-00
```

## AI Setup

Orbit uses the OpenAI SDK for AI-powered tasks.

Install the SDK:

```bash
npm install openai
```

Set your API key:

```bash
export OPENAI_API_KEY="your_api_key_here"
```

For local development, you can use a `.env` file:

```env
OPENAI_API_KEY=your_api_key_here
```

Then load it in the CLI entry file:

```ts
import 'dotenv/config';
```

or run with:

```json
{
  "scripts": {
    "dev": "tsx -r dotenv/config src/cli.tsx"
  }
}
```

Do not store API keys in:

```txt
~/.orbit/config.json
<project>/.orbit/config.json
```

## Scanning Strategy

Orbit uses a hybrid scan strategy.

### Deterministic Scan

The deterministic scan runs first and does not require AI.

It collects:

* Source files
* Config files
* Routes
* Components
* Tests
* Commands
* AI-related files
* Project logic files
* Utility files
* Type files
* Markdown files

It writes a project map to:

```txt
.orbit/index/project-map.json
```

### AI Scan

AI is used after deterministic scanning.

AI should not receive the whole repository blindly. Instead, Orbit should send selected files or grouped feature context to the model.

Good AI tasks include:

* Summarizing a feature
* Explaining a route
* Finding likely E2E scenarios
* Classifying ambiguous files
* Suggesting missing tests
* Understanding user-facing flows

## Memory Design

Orbit has two memory layers.

### Global Memory

Stored in:

```txt
~/.orbit/
```

Used for:

* User preferences
* Known initialized projects
* Last opened project
* Global configuration

### Local Project Memory

Stored in:

```txt
<project>/.orbit/
```

Used for:

* Project-specific scan results
* QA notes
* Feature summaries
* Testing decisions
* Failure patterns
* Generated reports

## Obsidian-Compatible Memory

Orbit memory is designed to work well with Markdown tools such as Obsidian.

A future memory structure may look like:

```txt
.orbit/memory/
  index.md
  features/
    login.md
    checkout.md
  tests/
    login-e2e.md
  failures/
    missing-seed-data.md
  decisions/
    playwright-strategy.md
```

Notes can use wiki-style links:

```md
# Login

Tags: #orbit #feature #auth

## Related

- [[login-e2e]]
- [[dashboard]]
- [[missing-test-user]]
```

This allows Obsidian to display a memory graph while Orbit can still parse the Markdown files itself.

## Development

Run Orbit in development mode:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Run built output:

```bash
npm start
```

Recommended `package.json` scripts:

```json
{
  "scripts": {
    "dev": "tsx -r dotenv/config src/cli.tsx",
    "build": "tsup src/cli.tsx --format esm --out-dir dist --clean",
    "start": "node dist/cli.js"
  }
}
```

## Project Detection

Orbit attempts to detect the project root by looking for markers such as:

```txt
package.json
playwright.config.*
cypress.config.*
next.config.*
vite.config.*
.git
.orbit
```

Project detection is read-only. It should not create `.orbit/`.

Orbit only creates `.orbit/` when the user runs:

```txt
/init
```

## Recommended `.gitignore`

For projects using Orbit, commit human-editable context if desired, but ignore generated runtime artifacts.

```gitignore
.orbit/index/
.orbit/sessions/
.orbit/reports/
.orbit/traces/
```

Usually safe to commit:

```txt
.orbit/project.json
.orbit/config.json
.orbit/memory/*.md
```

But this depends on the team’s preference.

Do not commit secrets, tokens, credentials, or sensitive test data.

## Safety Rules

Orbit should ask before:

* Creating files
* Modifying source code
* Running shell commands
* Running tests
* Deleting local Orbit context
* Re-initializing an existing `.orbit/` folder

Orbit should never store:

* API keys
* Passwords
* Tokens
* `.env` contents
* Real customer data
* Sensitive production data

## Roadmap

Planned features:

* AI-assisted project summaries
* Feature map generation
* Playwright test generation
* Test execution through Orbit
* Test repair suggestions
* File patch approval flow
* Obsidian-style memory graph
* Project switching
* Incremental scanning
* Better feature classification
* Report generation
* Local model support
* Provider abstraction for different AI models

## Example Workflow

```bash
cd ~/Documents/GitHub/shop-app
orbit
```

Inside Orbit:

```txt
/init
```

Orbit confirms the project name, creates `.orbit/`, scans the project, and remembers it globally.

Then:

```txt
/scan
```

refreshes the project index.

Then:

```txt
/ai give me Playwright E2E test ideas for the checkout flow
```

asks the AI model for testing ideas.

## Philosophy

Orbit should be:

* Terminal-first
* Safe by default
* Project-aware
* QA-focused
* Human-readable
* Obsidian-compatible
* AI-assisted, not AI-dependent

The deterministic scanner should make Orbit useful even without AI.

The AI layer should make Orbit smarter, but not fragile.
