import fs from 'node:fs';
import path from 'node:path';
import { walkProjectFiles } from './path.js';
import {
  buildChecksumsFile,
  checksumFromContent,
  compareChecksums,
  readChecksumsFile,
  writeChecksumsFile,
  type ChecksumDiff,
  type FileChecksumEntry,
} from './checksum.js';


export type ProjectMap = {
  generatedAt: string;
  projectRoot: string;
  framework: string | null;
  packageManager: string | null;
  testFramework: string | null;
  scripts: Record<string, string>;

  files: ScannedFile[];

  routes: ProjectRoute[];
  components: ProjectComponent[];
  tests: ProjectTest[];
  commands: ScannedFile[];
  aiFiles: ScannedFile[];
  projectLogicFiles: ScannedFile[];
  typeFiles: ScannedFile[];
  utilityFiles: ScannedFile[];

  configs: string[];
  filesScanned: number;

  // What changed since the previous scan (based on the checksums index).
  // Every file is reported as "added" on the very first scan.
  checksumDiff: ChecksumDiff;
};

export type SourceFileRole =
  | 'entry'
  | 'route'
  | 'component'
  | 'command'
  | 'ai'
  | 'project-logic'
  | 'type'
  | 'test'
  | 'config'
  | 'utility'
  | 'markdown'
  | 'unknown';

export type ScannedFile = {
  file: string;
  role: SourceFileRole;
  extension: string;
  featureGuess: string | null;
  reasons: string[];
  imports: string[];
  exports: string[];
  textSignals: string[];
};

export type ProjectRoute = {
  route: string;
  file: string;
  featureGuess: string;
};

export type ProjectComponent = {
  name: string;
  file: string;
  featureGuess: string | null;
};

export type ProjectTest = {
  file: string;
  featureGuess: string | null;
};

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
]);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);


export function formatScanResult(projectMap: ProjectMap, projectMapPath: string) {
    const {checksumDiff} = projectMap;
    const isFirstScan =
      checksumDiff.changed.length === 0 &&
      checksumDiff.deleted.length === 0 &&
      checksumDiff.unchanged.length === 0;

    const changesText = isFirstScan
      ? `Initial scan — indexed ${checksumDiff.added.length} file(s).`
      : `- Added: ${checksumDiff.added.length}
- Changed: ${checksumDiff.changed.length}
- Deleted: ${checksumDiff.deleted.length}
- Unchanged: ${checksumDiff.unchanged.length}`;

    return `Project scan complete.

Detected:
- Framework: ${projectMap.framework ?? 'Unknown'}
- Package manager: ${projectMap.packageManager ?? 'Unknown'}
- Test framework: ${projectMap.testFramework ?? 'Unknown'}

Found:
- Routes: ${projectMap.routes.length}
- Components: ${projectMap.components.length}
- Tests: ${projectMap.tests.length}
- Config files: ${projectMap.configs.length}
- Files scanned: ${projectMap.filesScanned}

Changes since last scan:
${changesText}

Saved:
- ${projectMapPath}`
}


export async function scanProject(projectRoot: string): Promise<ProjectMap> {
  const previousChecksums = readChecksumsFile(projectRoot);
  const previousProjectMap = readProjectMap(projectRoot);
  const previousFilesByPath = new Map(
    (previousProjectMap?.files ?? []).map((file) => [file.file, file] as const),
  );

  const files = walkProjectFiles(projectRoot);
  const checksumEntries: Record<string, FileChecksumEntry> = {};

  const scannedFiles = files.map((file) => {
    const absolutePath = path.join(projectRoot, file);
    const stats = fs.statSync(absolutePath);
    const previousChecksum = previousChecksums?.files[file];
    const previousScannedFile = previousFilesByPath.get(file);

    // Skip re-reading and re-parsing files that look unchanged since the
    // last scan (same size and mtime as the recorded checksum entry).
    if (
      previousChecksum &&
      previousScannedFile &&
      previousChecksum.sizeBytes === stats.size &&
      previousChecksum.modifiedAt === stats.mtime.toISOString()
    ) {
      checksumEntries[file] = previousChecksum;
      return previousScannedFile;
    }

    const {scannedFile, checksum} = analyzeFile(absolutePath, file, stats);
    checksumEntries[file] = checksum;
    return scannedFile;
  });

  const newChecksums = buildChecksumsFile(checksumEntries);
  writeChecksumsFile(projectRoot, newChecksums);
  const checksumDiff = compareChecksums(previousChecksums, newChecksums);

  const packageJson = readPackageJson(projectRoot);

  const configs = detectConfigs(files);
  const framework = detectFramework(files, packageJson);
  const packageManager = detectPackageManager(projectRoot);
  const testFramework = detectTestFramework(files, packageJson);

  const routes = detectRoutes(files);

  const components = scannedFiles
    .filter((file) => file.role === 'component')
    .map((file) => ({
      name: path.basename(file.file, path.extname(file.file)),
      file: file.file,
      featureGuess: file.featureGuess,
    }));

  const tests = scannedFiles
    .filter((file) => file.role === 'test')
    .map((file) => ({
      file: file.file,
      featureGuess: file.featureGuess,
    }));

  return {
    generatedAt: new Date().toISOString(),
    projectRoot,
    framework,
    packageManager,
    testFramework,
    scripts: packageJson?.scripts ?? {},

    files: scannedFiles,

    routes,
    components,
    tests,
    commands: scannedFiles.filter((file) => file.role === 'command'),
    aiFiles: scannedFiles.filter((file) => file.role === 'ai'),
    projectLogicFiles: scannedFiles.filter(
      (file) => file.role === 'project-logic',
    ),
    typeFiles: scannedFiles.filter((file) => file.role === 'type'),
    utilityFiles: scannedFiles.filter((file) => file.role === 'utility'),

    configs,
    filesScanned: scannedFiles.length,

    checksumDiff,
  };
}


// Reads and hashes a file once, reusing that single read for both the
// checksum entry and (for source files) the regex-based classification —
// avoids the double filesystem read that used to happen on every scan.
function analyzeFile(
  absolutePath: string,
  file: string,
  stats: fs.Stats,
): {scannedFile: ScannedFile; checksum: FileChecksumEntry} {
  const ext = path.extname(file);
  let buffer: Buffer | null = null;

  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    buffer = null;
  }

  const checksum: FileChecksumEntry = {
    checksum: checksumFromContent(buffer ?? Buffer.alloc(0)),
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    scannedAt: new Date().toISOString(),
  };

  const signals =
    buffer && SOURCE_EXTENSIONS.has(ext)
      ? extractSignalsFromContent(buffer.toString('utf8'))
      : {imports: [], exports: [], textSignals: []};

  return {
    scannedFile: classifyFile(file, signals),
    checksum,
  };
}


function classifyFile(
  file: string,
  signals: {imports: string[]; exports: string[]; textSignals: string[]},
): ScannedFile {
  const base = path.basename(file);
  const ext = path.extname(file);
  const normalized = file.toLowerCase();

  const reasons: string[] = [];
  let role: SourceFileRole = 'unknown';

  if (
    base === 'package.json' ||
    base === 'tsconfig.json' ||
    base.includes('config')
  ) {
    role = 'config';
    reasons.push('config-like filename');
  } else if (MARKDOWN_EXTENSIONS.has(ext)) {
    role = 'markdown';
    reasons.push('markdown file');
  } else if (
    signals.textSignals.some((signal) => signal.startsWith('command:'))
  ) {
    role = 'command';
    reasons.push('contains command metadata');
  } else if (isTestFile(file)) {
    role = 'test';
    reasons.push('test filename or test folder pattern');
  } else if (isRouteFile(file)) {
    role = 'route';
    reasons.push('route/page file pattern');
  } else if (normalized.endsWith('app.tsx') || normalized.endsWith('cli.tsx')) {
    role = 'entry';
    reasons.push('entry-like filename');
  } else if (normalized.includes('/commands/')) {
    role = 'command';
    reasons.push('inside commands folder');
  } else if (
    normalized.includes('/ai/') ||
    signals.imports.includes('openai') ||
    signals.imports.some((item) => item.includes('openai'))
  ) {
    role = 'ai';
    reasons.push('ai folder or OpenAI import');
  } else if (normalized.includes('/project/')) {
    role = 'project-logic';
    reasons.push('inside project folder');
  } else if (normalized.includes('/types/') || normalized.endsWith('.d.ts')) {
    role = 'type';
    reasons.push('type definition file');
  } else if (normalized.includes('/utils/') || normalized.includes('/lib/')) {
    role = 'utility';
    reasons.push('utility/lib folder');
  } else if (ext === '.tsx' || ext === '.jsx') {
    role = 'component';
    reasons.push('tsx/jsx source file');
  } else if (SOURCE_EXTENSIONS.has(ext)) {
    role = 'utility';
    reasons.push('generic source file');
  }

  return {
    file,
    role,
    extension: ext,
    featureGuess: guessFeatureFromText(
      [file, ...signals.exports, ...signals.textSignals].join(' '),
    ),
    reasons,
    imports: signals.imports,
    exports: signals.exports,
    textSignals: signals.textSignals,
  };
}

function extractSignalsFromContent(content: string) {
  const preview = content.slice(0, 12_000);

  const imports = Array.from(
    preview.matchAll(/import\s+.*?\s+from\s+['"](.+?)['"]/g),
  ).map((match) => match[1]!);

  const exports = Array.from(
    preview.matchAll(
      /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|type|class|interface)\s+([A-Za-z0-9_]+)/g,
    ),
  ).map((match) => match[1]!);

  const commandNames = Array.from(
    preview.matchAll(/name:\s*['"]([^'"]+)['"]/g),
  ).map((match) => `command:${match[1]}`);

  const usages = Array.from(
    preview.matchAll(/usage:\s*['"]([^'"]+)['"]/g),
  ).map((match) => `usage:${match[1]}`);

  const jsxText = Array.from(preview.matchAll(/>([^<>{}]{3,80})</g))
    .map((match) => match[1]!.trim())
    .filter(Boolean)
    .slice(0, 20);

  return {
    imports,
    exports,
    textSignals: [...commandNames, ...usages, ...jsxText],
  };
}

function readPackageJson(projectRoot: string): PackageJson | null {
  const packageJsonPath = path.join(projectRoot, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

function detectConfigs(files: string[]) {
  return files.filter((file) => {
    const base = path.basename(file);

    return (
      base === 'package.json' ||
      base === 'tsconfig.json' ||
      base.startsWith('next.config') ||
      base.startsWith('vite.config') ||
      base.startsWith('playwright.config') ||
      base.startsWith('cypress.config') ||
      base.startsWith('vitest.config')
    );
  });
}

function detectPackageManager(projectRoot: string) {
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(projectRoot, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(projectRoot, 'package-lock.json'))) return 'npm';

  return null;
}

function detectFramework(files: string[], packageJson: PackageJson | null) {
  const deps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };

  if (files.some((file) => path.basename(file).startsWith('next.config'))) {
    return 'Next.js';
  }

  if ('next' in deps) return 'Next.js';
  if ('@sveltejs/kit' in deps) return 'SvelteKit';
  if ('vite' in deps) return 'Vite';
  if ('react' in deps) return 'React';
  if ('vue' in deps) return 'Vue';
  if ('@angular/core' in deps) return 'Angular';
  if ('svelte' in deps) return 'Svelte';

  return null;
}

function detectTestFramework(files: string[], packageJson: PackageJson | null) {
  const deps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };

  if (
    files.some((file) => path.basename(file).startsWith('playwright.config'))
  ) {
    return 'Playwright';
  }

  if ('@playwright/test' in deps) return 'Playwright';

  if (files.some((file) => path.basename(file).startsWith('cypress.config'))) {
    return 'Cypress';
  }

  if ('cypress' in deps) return 'Cypress';
  if ('vitest' in deps) return 'Vitest';
  if ('jest' in deps) return 'Jest';

  return null;
}

// Route detection only understands file-convention-based routers
// (Next.js, SvelteKit, Remix). Config-based routers (React Router, Vue
// Router, Angular) define routes in code rather than by file location, so
// they can't be picked up by walking the file tree — that would need real
// source parsing, not a filename heuristic.
function detectRoutes(files: string[]): ProjectRoute[] {
  const routes: ProjectRoute[] = [];

  for (const file of files) {
    if (!isSourceFile(file)) continue;

    const normalized = file.split(path.sep).join('/');

    const appRoute = getNextAppRoute(normalized);
    if (appRoute) {
      routes.push({
        route: appRoute,
        file,
        featureGuess: guessFeatureFromRoute(appRoute),
      });
      continue;
    }

    const pagesRoute = getNextPagesRoute(normalized);
    if (pagesRoute) {
      routes.push({
        route: pagesRoute,
        file,
        featureGuess: guessFeatureFromRoute(pagesRoute),
      });
      continue;
    }

    const svelteKitRoute = getSvelteKitRoute(normalized);
    if (svelteKitRoute) {
      routes.push({
        route: svelteKitRoute,
        file,
        featureGuess: guessFeatureFromRoute(svelteKitRoute),
      });
      continue;
    }

    const remixRoute = getRemixRoute(normalized);
    if (remixRoute) {
      routes.push({
        route: remixRoute,
        file,
        featureGuess: guessFeatureFromRoute(remixRoute),
      });
      continue;
    }
  }

  return routes;
}

function getNextAppRoute(file: string) {
  const homeMatch = file.match(/^(src\/)?app\/page\.(tsx|ts|jsx|js)$/);

  if (homeMatch) {
    return '/';
  }

  const match = file.match(/^(src\/)?app\/(.+)\/page\.(tsx|ts|jsx|js)$/);

  if (!match) return null;

  const routePart = match[2]!
    .replace(/\/\(.*?\)/g, '')
    .replace(/\[(.+?)\]/g, ':$1');

  return routePart ? `/${routePart}` : '/';
}

function getNextPagesRoute(file: string) {
  const match = file.match(/^(src\/)?pages\/(.+)\.(tsx|ts|jsx|js)$/);

  if (!match) return null;

  let routePart = match[2]!;

  if (routePart.startsWith('api/')) {
    return null;
  }

  routePart = routePart
    .replace(/\/index$/, '')
    .replace(/^index$/, '')
    .replace(/\[(.+?)\]/g, ':$1');

  return routePart ? `/${routePart}` : '/';
}

function getSvelteKitRoute(file: string) {
  const match = file.match(/^(src\/)?routes\/(.*\/)?\+page\.(svelte|ts|js)$/);

  if (!match) return null;

  const dirPart = match[2] ?? '';
  const routePart = dirPart
    .replace(/\/$/, '')
    .split('/')
    .filter(Boolean)
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => segment.replace(/\[(\.\.\.)?(.+?)\]/g, ':$2'))
    .join('/');

  return routePart ? `/${routePart}` : '/';
}

function getRemixRoute(file: string) {
  const match = file.match(/^app\/routes\/(.+)\.(tsx|ts|jsx|js)$/);

  if (!match) return null;

  const routeId = match[1]!;

  if (routeId === '_index') return '/';

  const segments = routeId
    .split('.')
    .filter((segment) => segment && !segment.startsWith('_'));

  if (segments.length === 0) return '/';

  const routePart = segments
    .map((segment) => (segment.startsWith('$') ? `:${segment.slice(1)}` : segment))
    .join('/');

  return routePart ? `/${routePart}` : '/';
}

function isRouteFile(file: string) {
  const normalized = file.split(path.sep).join('/');

  return (
    /^(src\/)?app\/page\.(tsx|ts|jsx|js)$/.test(normalized) ||
    /^(src\/)?app\/(.+)\/page\.(tsx|ts|jsx|js)$/.test(normalized) ||
    /^(src\/)?pages\/(.+)\.(tsx|ts|jsx|js)$/.test(normalized) ||
    /^(src\/)?routes\/(.*\/)?\+page\.(svelte|ts|js)$/.test(normalized) ||
    /^app\/routes\/(.+)\.(tsx|ts|jsx|js)$/.test(normalized)
  );
}

function isTestFile(file: string) {
  const normalized = file.split(path.sep).join('/');

  return (
    /\.(spec|test)\.(ts|tsx|js|jsx)$/.test(normalized) ||
    normalized.startsWith('tests/') ||
    normalized.startsWith('e2e/') ||
    normalized.includes('/e2e/') ||
    normalized.includes('/tests/')
  );
}

function isSourceFile(file: string) {
  return SOURCE_EXTENSIONS.has(path.extname(file));
}

function guessFeatureFromRoute(route: string) {
  const parts = route
    .split('/')
    .filter(Boolean)
    .filter((part) => !part.startsWith(':'));

  if (parts.length === 0) return 'home';

  return normalizeFeatureName(parts[0]!);
}

function guessFeatureFromText(text: string) {
  const normalized = text
    .replace(/\.(spec|test)\.(ts|tsx|js|jsx)$/, '')
    .replace(/\.(ts|tsx|js|jsx)$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();

  const knownFeatures = [
    // Common web app features
    'login',
    'signin',
    'sign in',
    'signup',
    'sign up',
    'register',
    'auth',
    'checkout',
    'cart',
    'dashboard',
    'profile',
    'settings',
    'product',
    'products',
    'order',
    'orders',
    'payment',
    'password',
    'reset',

    // Orbit / CLI features
    'init',
    'scan',
    'project',
    'projects',
    'memory',
    'ai',
    'abort',
    'cancel',
    'command',
    'commands',
    'detect',
    'selection',
    'config',
    'global',
    'openai',
    'model',
  ];

  const match = knownFeatures.find((feature) => normalized.includes(feature));

  if (!match) return null;

  return normalizeFeatureName(match);
}

function normalizeFeatureName(value: string) {
  const normalized = value.toLowerCase().trim();

  if (['signin', 'sign in'].includes(normalized)) return 'login';
  if (['signup', 'sign up', 'register'].includes(normalized)) return 'signup';
  if (['password', 'reset'].includes(normalized)) return 'password-reset';
  if (['products', 'product'].includes(normalized)) return 'products';
  if (['orders', 'order'].includes(normalized)) return 'orders';
  if (['commands', 'command'].includes(normalized)) return 'commands';
  if (['projects', 'project'].includes(normalized)) return 'projects';
  if (['openai', 'model'].includes(normalized)) return 'ai';
  if (['cancel'].includes(normalized)) return 'abort';

  return normalized.replace(/\s+/g, '-');
}

function getProjectMapPath(projectRoot: string) {
  return path.join(projectRoot, '.orbit', 'index', 'project-map.json');
}

export function readProjectMap(projectRoot: string): ProjectMap | null {
  const projectMapPath = getProjectMapPath(projectRoot);

  if (!fs.existsSync(projectMapPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(projectMapPath, 'utf8')) as ProjectMap;
  } catch {
    return null;
  }
}

export function writeProjectMap(projectRoot: string, projectMap: ProjectMap) {
  const projectMapPath = getProjectMapPath(projectRoot);

  fs.mkdirSync(path.dirname(projectMapPath), {recursive: true});
  fs.writeFileSync(projectMapPath, JSON.stringify(projectMap, null, 2), 'utf8');
  return projectMapPath;
}
