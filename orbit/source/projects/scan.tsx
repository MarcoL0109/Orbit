import fs from 'node:fs';
import path from 'node:path';


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

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.orbit',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'playwright-report',
  'test-results',
]);

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

const IMPORTANT_FILES = new Set([
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mts',
  'next.config.ts',
  'next.config.js',
  'next.config.mjs',
  'playwright.config.ts',
  'playwright.config.js',
  'cypress.config.ts',
  'cypress.config.js',
  'vitest.config.ts',
  'vitest.config.js',
  'README.md',
]);

export async function scanProject(projectRoot: string): Promise<ProjectMap> {
  const files = walkProjectFiles(projectRoot);
  const scannedFiles = files.map((file) => classifyFile(projectRoot, file));

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
  };
}

function walkProjectFiles(projectRoot: string) {
  const results: string[] = [];

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.relative(projectRoot, absolutePath);
      const normalizedPath = relativePath.split(path.sep).join('/');

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) {
          continue;
        }

        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const ext = path.extname(entry.name);
      const base = path.basename(entry.name);

      if (
        SOURCE_EXTENSIONS.has(ext) ||
        MARKDOWN_EXTENSIONS.has(ext) ||
        IMPORTANT_FILES.has(base)
      ) {
        results.push(normalizedPath);
      }
    }
  }

  walk(projectRoot);

  return results.sort();
}

function classifyFile(projectRoot: string, file: string): ScannedFile {
  const base = path.basename(file);
  const ext = path.extname(file);
  const normalized = file.toLowerCase();
  const signals = extractSourceSignals(projectRoot, file);

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

function extractSourceSignals(projectRoot: string, file: string) {
  const absolutePath = path.join(projectRoot, file);

  if (!fs.existsSync(absolutePath)) {
    return {
      imports: [],
      exports: [],
      textSignals: [],
    };
  }

  const ext = path.extname(file);

  if (!SOURCE_EXTENSIONS.has(ext)) {
    return {
      imports: [],
      exports: [],
      textSignals: [],
    };
  }

  let content = '';

  try {
    content = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return {
      imports: [],
      exports: [],
      textSignals: [],
    };
  }

  const preview = content.slice(0, 12_000);

  const imports = Array.from(
    preview.matchAll(/import\s+.*?\s+from\s+['"](.+?)['"]/g),
  ).map((match) => match[1]);

  const exports = Array.from(
    preview.matchAll(
      /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|type|class|interface)\s+([A-Za-z0-9_]+)/g,
    ),
  ).map((match) => match[1]);

  const commandNames = Array.from(
    preview.matchAll(/name:\s*['"]([^'"]+)['"]/g),
  ).map((match) => `command:${match[1]}`);

  const usages = Array.from(
    preview.matchAll(/usage:\s*['"]([^'"]+)['"]/g),
  ).map((match) => `usage:${match[1]}`);

  const jsxText = Array.from(preview.matchAll(/>([^<>{}]{3,80})</g))
    .map((match) => match[1].trim())
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

  const routePart = match[2]
    .replace(/\/\(.*?\)/g, '')
    .replace(/\[(.+?)\]/g, ':$1');

  return routePart ? `/${routePart}` : '/';
}

function getNextPagesRoute(file: string) {
  const match = file.match(/^(src\/)?pages\/(.+)\.(tsx|ts|jsx|js)$/);

  if (!match) return null;

  let routePart = match[2];

  if (routePart.startsWith('api/')) {
    return null;
  }

  routePart = routePart
    .replace(/\/index$/, '')
    .replace(/^index$/, '')
    .replace(/\[(.+?)\]/g, ':$1');

  return routePart ? `/${routePart}` : '/';
}

function isRouteFile(file: string) {
  const normalized = file.split(path.sep).join('/');

  return (
    /^(src\/)?app\/page\.(tsx|ts|jsx|js)$/.test(normalized) ||
    /^(src\/)?app\/(.+)\/page\.(tsx|ts|jsx|js)$/.test(normalized) ||
    /^(src\/)?pages\/(.+)\.(tsx|ts|jsx|js)$/.test(normalized)
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

  return normalizeFeatureName(parts[0]);
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

export function writeProjectMap(projectRoot: string, projectMap: ProjectMap) {
  const indexDir = path.join(projectRoot, '.orbit', 'index');

  fs.mkdirSync(indexDir, {
    recursive: true,
  });

  const projectMapPath = path.join(indexDir, 'project-map.json');

  fs.writeFileSync(projectMapPath, JSON.stringify(projectMap, null, 2), 'utf8');

  return projectMapPath;
}

