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

// Layered guesses, most-trustworthy first: an explicit override in the dev
// script beats an .env default, which beats a bare framework convention —
// each of those only tells you what's likely, the earlier ones tell you
// what was actually configured.
function detectDevServerPort(projectRoot: string): number {
  const packageJson = readJsonFile<PackageJsonForPortDetection>(path.join(projectRoot, 'package.json'));

  const devScript = packageJson?.scripts?.['dev'] ?? packageJson?.scripts?.['start'] ?? '';
  const scriptPortMatch = devScript.match(/(?:--port|-p)[=\s]+(\d{2,5})/) ?? devScript.match(/\bPORT=(\d{2,5})/);
  if (scriptPortMatch?.[1]) {
    return Number(scriptPortMatch[1]);
  }

  for (const envFile of ['.env.local', '.env']) {
    const envPath = path.join(projectRoot, envFile);
    if (!fs.existsSync(envPath)) continue;

    const match = fs.readFileSync(envPath, 'utf8').match(/^PORT=(\d{2,5})/m);
    if (match?.[1]) return Number(match[1]);
  }

  const deps = {...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {})};
  const frameworkMatch = FRAMEWORK_DEFAULT_PORTS.find(({dependency}) => dependency in deps);
  if (frameworkMatch) return frameworkMatch.port;

  return 3000;
}

export function initOrbitProject({
  projectRoot,
  projectName,
  framework,
  packageManager,
  testFramework,
}: InitOrbitProjectOptions) {
  const now = new Date().toISOString();

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
      baseUrl: `http://localhost:${detectDevServerPort(projectRoot)}`,
      devCommand: null,
      testCommand: null,
      testDir: 'tests/e2e',
      writeMode: 'ask',
      maxRepairAttempts: 3,
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