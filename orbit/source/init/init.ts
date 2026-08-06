import fs from 'node:fs';
import path from 'node:path';
import type { OrbitConfig } from './config.js';

type InitOrbitProjectOptions = {
  projectRoot: string;
  projectName: string;
  framework?: string;
  packageManager?: string;
  testFramework?: string;
};

export type InitFileAction = {
  filePath: string;
  relativePath: string;
  action: 'created' | 'skipped';
};

type PackageJsonForPortDetection = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

// Checked most-specific-first: frameworks that are themselves built on Vite
// (SvelteKit) are matched before the generic 'vite' dependency, so they get
// their own port rather than always falling through to Vite's default.
const FRAMEWORK_DEFAULT_PORTS: Array<{dependency: string; port: number}> = [
  {dependency: 'next', port: 3000},
  {dependency: '@sveltejs/kit', port: 5173},
  {dependency: '@angular/core', port: 4200},
  {dependency: '@vue/cli-service', port: 8080},
  {dependency: 'vite', port: 5173},
];

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

// Common places a frontend's own package.json lives in a split/monorepo
// layout, checked when the project root itself has no dev server signal —
// e.g. a root package.json that only orchestrates ("build-prod": "yarn
// --cwd Frontend build") with the actual vite/next/etc. dependency one
// level down.
const FRONTEND_SUBFOLDER_CANDIDATES = ['Frontend', 'frontend', 'client', 'web'];

// Layered guesses, most-trustworthy first: an explicit override in the dev
// script beats an .env default, which beats a bare framework convention —
// each of those only tells you what's likely, the earlier ones tell you
// what was actually configured. Returns null (not a fallback port) so the
// caller can move on to the next candidate directory instead of locking in
// a default before checking a subfolder that might have a real answer.
function detectPortFromDirectory(dir: string): number | null {
  const packageJson = readJsonFile<PackageJsonForPortDetection>(path.join(dir, 'package.json'));

  const devScript = packageJson?.scripts?.['dev'] ?? packageJson?.scripts?.['start'] ?? '';
  const scriptPortMatch = devScript.match(/(?:--port|-p)[=\s]+(\d{2,5})/) ?? devScript.match(/\bPORT=(\d{2,5})/);
  if (scriptPortMatch?.[1]) {
    return Number(scriptPortMatch[1]);
  }

  for (const envFile of ['.env.local', '.env']) {
    const envPath = path.join(dir, envFile);
    if (!fs.existsSync(envPath)) continue;

    const match = fs.readFileSync(envPath, 'utf8').match(/^PORT=(\d{2,5})/m);
    if (match?.[1]) return Number(match[1]);
  }

  const deps = {...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {})};
  const frameworkMatch = FRAMEWORK_DEFAULT_PORTS.find(({dependency}) => dependency in deps);
  if (frameworkMatch) return frameworkMatch.port;

  return null;
}

const COMPOSE_FILE_CANDIDATES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

type DockerComposeDetection = {
  file: string | null;
  hasHealthchecks: boolean;
};

const FRONTEND_SERVICE_NAME_HINTS = ['frontend', 'web', 'client', 'ui', 'app'];

// Line-scan, not a real YAML parse: tracks which top-level service block
// (2-space-indented "name:" under services:) each line belongs to, and only
// reads a "HOST:CONTAINER" port mapping while inside a service whose name
// looks frontend-like. This matters — a compose file's OTHER services (a
// backend, a cache, a database) commonly expose their own ports too, and
// grabbing the first port found anywhere would just as easily return one of
// those instead of the one a browser actually needs to hit. Standard 2-space
// compose indentation is assumed; anything else silently finds nothing here.
function detectDockerComposeFrontendPort(composeFilePath: string): number | null {
  let content: string;
  try {
    content = fs.readFileSync(composeFilePath, 'utf8');
  } catch {
    return null;
  }

  let inFrontendLikeService = false;

  for (const line of content.split('\n')) {
    // Top-level key (e.g. "volumes:" after the services block) always exits
    // whatever service block preceded it.
    if (/^\S/.test(line)) {
      inFrontendLikeService = false;
      continue;
    }

    const serviceMatch = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*(#.*)?$/);
    if (serviceMatch) {
      const name = serviceMatch[1]!.toLowerCase();
      inFrontendLikeService = FRONTEND_SERVICE_NAME_HINTS.some((hint) => name.includes(hint));
      continue;
    }

    if (!inFrontendLikeService) continue;

    const portMatch = line.match(/^\s*-\s*["']?(\d{2,5}):(\d{2,5})["']?\s*(#.*)?$/);
    if (portMatch?.[1]) {
      return Number(portMatch[1]);
    }
  }

  return null;
}

// A compose-mapped frontend port is checked first when available — it's the
// actual host-reachable port for a containerized dev setup regardless of
// what a service's own internal script/env thinks its port is (Compose can
// remap it to anything). Falls through to the non-Docker signals otherwise.
function detectDevServerPort(projectRoot: string, dockerCompose: DockerComposeDetection): number {
  if (dockerCompose.file) {
    const composePort = detectDockerComposeFrontendPort(path.join(projectRoot, dockerCompose.file));
    if (composePort !== null) return composePort;
  }

  const candidateDirs = [projectRoot, ...FRONTEND_SUBFOLDER_CANDIDATES.map((sub) => path.join(projectRoot, sub))];

  for (const dir of candidateDirs) {
    const port = detectPortFromDirectory(dir);
    if (port !== null) return port;
  }

  return 3000;
}

// Detect-and-store only — no YAML parser dependency for what's just a
// presence check. A top-level-indented "healthcheck:" key is specific
// enough in compose files (not a word that shows up as a stray value) that
// a line-anchored regex is a reasonable, dependency-free heuristic here;
// a future phase that actually needs per-service detail can revisit this.
function detectDockerCompose(projectRoot: string): DockerComposeDetection {
  for (const candidate of COMPOSE_FILE_CANDIDATES) {
    const fullPath = path.join(projectRoot, candidate);
    if (!fs.existsSync(fullPath)) continue;

    let hasHealthchecks = false;
    try {
      hasHealthchecks = /^\s*healthcheck:\s*$/m.test(fs.readFileSync(fullPath, 'utf8'));
    } catch {
      // File exists but couldn't be read — still report it as found, just
      // without healthcheck info.
    }

    return {file: candidate, hasHealthchecks};
  }

  return {file: null, hasHealthchecks: false};
}

export function initOrbitProject({
  projectRoot,
  projectName,
  framework,
  packageManager,
  testFramework,
}: InitOrbitProjectOptions) {
  const now = new Date().toISOString();
  const dockerCompose = detectDockerCompose(projectRoot);

  const orbitDir = path.join(projectRoot, '.orbit');
  const indexDir = path.join(orbitDir, 'index');
  const memoryDir = path.join(orbitDir, 'memory');
  const sessionsDir = path.join(orbitDir, 'sessions');
  const tracesDir = path.join(orbitDir, 'traces');

  fs.mkdirSync(indexDir, {recursive: true});
  fs.mkdirSync(memoryDir, {recursive: true});
  fs.mkdirSync(sessionsDir, {recursive: true});
  fs.mkdirSync(tracesDir, {recursive: true});

  const files: InitFileAction[] = [
    writeJsonIfMissing(projectRoot, path.join(orbitDir, 'project.json'), {
      name: projectName,
      root: projectRoot,
      framework: framework ?? null,
      packageManager: packageManager ?? null,
      testFramework: testFramework ?? null,
      createdAt: now,
      updatedAt: now,
    }),

    writeJsonIfMissing(projectRoot, path.join(orbitDir, 'config.json'), {
      approvalMode: 'ask',
      defaultBrowser: 'chromium',
      baseUrl: `http://localhost:${detectDevServerPort(projectRoot, dockerCompose)}`,
      devCommand: dockerCompose.file ? 'docker compose up' : null,
      testCommand: null,
      testDir: 'Orbit_test/e2e',
      manualTestDir: 'Orbit_test/user_input_test',
      writeMode: 'ask',
      maxRepairAttempts: 3,
      dockerComposeFile: dockerCompose.file,
      dockerComposeHasHealthchecks: dockerCompose.hasHealthchecks,
    } satisfies OrbitConfig),

    writeTextIfMissing(
      projectRoot,
      path.join(memoryDir, 'overview.md'),
      `# Orbit Project Memory

## Overview

Orbit was initialized for this project on ${now}.

## Project Notes

- Add useful QA notes here.

## Important Flows

- Login
- Signup
- Checkout
- Dashboard
`,
    ),

    writeTextIfMissing(
      projectRoot,
      path.join(memoryDir, 'decisions.md'),
      `
# Decisions

## Testing Strategy

- Prefer Playwright for E2E tests.
- Prefer role-based selectors such as \`getByRole\`, \`getByLabel\`, and \`getByText\`.
- Ask before creating or editing files.
- Ask before running shell commands.
`,
    ),

    writeTextIfMissing(
      projectRoot,
      path.join(memoryDir, 'failures.md'),
      `
# Failure Memory

Orbit will record useful test failure patterns here.

Do not store secrets, passwords, tokens, or full raw logs.
`,
    ),
  ];

  return {
    orbitDir,
    projectJsonPath: path.join(orbitDir, 'project.json'),
    configJsonPath: path.join(orbitDir, 'config.json'),
    indexDir,
    memoryDir,
    sessionsDir,
    tracesDir,
    files,
  };
}

function writeJsonIfMissing(
  projectRoot: string,
  filePath: string,
  data: unknown,
): InitFileAction {
  const relativePath = path.relative(projectRoot, filePath);

  if (fs.existsSync(filePath)) {
    return {
      filePath,
      relativePath,
      action: 'skipped',
    };
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');

  return {
    filePath,
    relativePath,
    action: 'created',
  };
}

function writeTextIfMissing(
  projectRoot: string,
  filePath: string,
  content: string,
): InitFileAction {
  const relativePath = path.relative(projectRoot, filePath);

  if (fs.existsSync(filePath)) {
    return {
      filePath,
      relativePath,
      action: 'skipped',
    };
  }

  fs.writeFileSync(filePath, content, 'utf8');

  return {
    filePath,
    relativePath,
    action: 'created',
  };
}