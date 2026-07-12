import fs from 'node:fs';
import path from 'node:path';

export type ProjectMap = {
    generatedAt: string;
    projectRoot: string;
    framework: string | null;
    packageManager: string | null;
    testFramework: string | null;
    scripts: Record<string, string>;
    routes: ProjectRoute[];
    components: ProjectComponent[];
    tests: ProjectTest[];
    configs: string[];
    filesScanned: number;
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
    '.mjs',
    '.cjs',
]);

export async function scanProject(projectRoot: string): Promise<ProjectMap> {
  const files = walkProjectFiles(projectRoot);

  const packageJson = readPackageJson(projectRoot);

  const configs = detectConfigs(files);
  const framework = detectFramework(files, packageJson);
  const packageManager = detectPackageManager(projectRoot);
  const testFramework = detectTestFramework(files, packageJson);

  const routes = detectRoutes(projectRoot, files);
  const components = detectComponents(projectRoot, files);
  const tests = detectTests(projectRoot, files);

  return {
    generatedAt: new Date().toISOString(),
    projectRoot,
    framework,
    packageManager,
    testFramework,
    scripts: packageJson?.scripts ?? {},
    routes,
    components,
    tests,
    configs,
    filesScanned: files.length,
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

      results.push(relativePath);
    }
  }

  walk(projectRoot);

  return results;
}

function readPackageJson(projectRoot: string): {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
} | null {
  const packageJsonPath = path.join(projectRoot, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function detectConfigs(files: string[]) {
  return files.filter((file) => {
    const base = path.basename(file);

    return (
      base === 'package.json' ||
      base.startsWith('next.config') ||
      base.startsWith('vite.config') ||
      base.startsWith('playwright.config') ||
      base.startsWith('cypress.config') ||
      base.startsWith('vitest.config') ||
      base === 'tsconfig.json'
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

function detectFramework(
  files: string[],
  packageJson: ReturnType<typeof readPackageJson>,
) {
  const deps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };

  if (files.some((file) => path.basename(file).startsWith('next.config'))) {
    return 'Next.js';
  }

  if ('next' in deps) return 'Next.js';
  if ('vite' in deps) return 'Vite';
  if ('react' in deps) return 'React';
  if ('vue' in deps) return 'Vue';
  if ('@angular/core' in deps) return 'Angular';
  if ('svelte' in deps || '@sveltejs/kit' in deps) return 'Svelte';

  return null;
}

function detectTestFramework(
  files: string[],
  packageJson: ReturnType<typeof readPackageJson>,
) {
  const deps = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };

  if (files.some((file) => path.basename(file).startsWith('playwright.config'))) {
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


function detectRoutes(projectRoot: string, files: string[]): ProjectRoute[] {
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
  const match = file.match(/^(src\/)?app\/(.+)\/page\.(tsx|ts|jsx|js)$/);

  if (!match) return null;

  const routePart = match[2]
    .replace(/\/\(.*?\)/g, '')
    .replace(/\[(.+?)\]/g, ':$1');

  if (!routePart || routePart === 'page') {
    return '/';
  }

  return `/${routePart}`;
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


function detectComponents(projectRoot: string, files: string[]): ProjectComponent[] {
  return files
    .filter((file) => isSourceFile(file))
    .filter((file) => {
      const normalized = file.split(path.sep).join('/');

      return (
        normalized.includes('/components/') ||
        normalized.startsWith('components/') ||
        /[A-Z][A-Za-z0-9]+\.(tsx|jsx)$/.test(path.basename(file))
      );
    })
    .map((file) => {
      const name = path.basename(file, path.extname(file));

      return {
        name,
        file,
        featureGuess: guessFeatureFromText(name),
      };
    });
}

function detectTests(projectRoot: string, files: string[]): ProjectTest[] {
  return files
    .filter((file) => {
      const normalized = file.split(path.sep).join('/');

      return (
        /\.(spec|test)\.(ts|tsx|js|jsx)$/.test(file) ||
        normalized.startsWith('tests/') ||
        normalized.startsWith('e2e/') ||
        normalized.includes('/e2e/') ||
        normalized.includes('/tests/')
      );
    })
    .map((file) => ({
      file,
      featureGuess: guessFeatureFromText(path.basename(file)),
    }));
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
    .toLowerCase();

  const knownFeatures = [
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

  return normalized.replace(/\s+/g, '-');
}


export function writeProjectMap(projectRoot: string, projectMap: ProjectMap) {
  const indexDir = path.join(projectRoot, '.orbit', 'index');

  fs.mkdirSync(indexDir, {
    recursive: true,
  });

  const projectMapPath = path.join(indexDir, 'project-map.json');

  fs.writeFileSync(
    projectMapPath,
    JSON.stringify(projectMap, null, 2),
    'utf8',
  );

  return projectMapPath;
}