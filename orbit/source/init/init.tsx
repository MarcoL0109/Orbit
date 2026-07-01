import fs from 'node:fs';
import path from 'node:path';


type InitOrbitProjectOptions = {
    projectRoot: string;
    projectName: string;
    framework?: string;
    packageManager?: string;
    testFramework?: string;
};

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
  const reportsDir = path.join(orbitDir, 'reports');
  const tracesDir = path.join(orbitDir, 'traces');

  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(tracesDir, { recursive: true });

  writeJsonIfMissing(path.join(orbitDir, 'project.json'), {
    name: projectName,
    root: projectRoot,
    framework: framework ?? null,
    packageManager: packageManager ?? null,
    testFramework: testFramework ?? null,
    createdAt: now,
    updatedAt: now,
  });

  writeJsonIfMissing(path.join(orbitDir, 'config.json'), {
    approvalMode: 'ask',
    defaultBrowser: 'chromium',
    baseUrl: 'http://localhost:3000',
    devCommand: null,
    testCommand: null,
    testDir: 'tests/e2e',
    writeMode: 'ask',
    maxRepairAttempts: 3,
  });

  writeJsonIfMissing(path.join(indexDir, 'project-map.json'), {
    generatedAt: now,
    routes: [],
    components: [],
    tests: [],
    scripts: {},
    dependencies: {},
    notes: [],
  });

  writeJsonIfMissing(path.join(indexDir, 'checksums.json'), {
    generatedAt: now,
    files: {},
  });

  writeTextIfMissing(
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
  );

  writeTextIfMissing(
    path.join(memoryDir, 'decisions.md'),
    `# Decisions

## Testing Strategy

- Prefer Playwright for E2E tests.
- Prefer role-based selectors such as \`getByRole\`, \`getByLabel\`, and \`getByText\`.
- Ask before creating or editing files.
- Ask before running shell commands.
`,
  );

  writeTextIfMissing(
    path.join(memoryDir, 'failures.md'),
    `# Failure Memory

Orbit will record useful test failure patterns here.

Do not store secrets, passwords, tokens, or full raw logs.
`,
  );

  return {
    orbitDir,
    projectJsonPath: path.join(orbitDir, 'project.json'),
    configJsonPath: path.join(orbitDir, 'config.json'),
    indexDir,
    memoryDir,
    sessionsDir,
    reportsDir,
    tracesDir,
  };
}

function writeJsonIfMissing(filePath: string, data: unknown) {
    if (fs.existsSync(filePath)) return;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function writeTextIfMissing(filePath: string, content: string) {
    if (fs.existsSync(filePath)) return;
    fs.writeFileSync(filePath, content, 'utf8');
}