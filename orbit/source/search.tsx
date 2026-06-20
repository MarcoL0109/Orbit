import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';


type ProjectDetectionResult = {
  isProject: boolean;
  root: string | null;
  confidence: number;
  markers: string[];
  packageManager?: 'pnpm' | 'npm' | 'yarn' | 'bun';
  framework?: string;
  testFramework?: string;
};

const STRONG_MARKERS = [
  'package.json',
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mts',
  'cypress.config.ts',
  'cypress.config.js',
  'vite.config.ts',
  'vite.config.js',
  'next.config.ts',
  'next.config.js',
  '.git',
  '.orbit',
  'orbit.config.ts',
  'orbit.config.js',
];

const MEDIUM_MARKERS = [
  'src',
  'app',
  'pages',
  'tests',
  'e2e',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
];

function exists(targetPath: string): boolean {
  return fs.existsSync(targetPath);
}

function getMarkers(dir: string): string[] {
  const markers: string[] = [];

  for (const marker of [...STRONG_MARKERS, ...MEDIUM_MARKERS]) {
    if (exists(path.join(dir, marker))) {
      markers.push(marker);
    }
  }

  return markers;
}

function scoreMarkers(markers: string[]): number {
  let score = 0;

  for (const marker of markers) {
    if (marker === '.orbit') score += 50;
    else if (marker.startsWith('orbit.config')) score += 50;
    else if (marker === 'package.json') score += 35;
    else if (marker.startsWith('playwright.config')) score += 35;
    else if (marker.startsWith('cypress.config')) score += 30;
    else if (marker.startsWith('next.config')) score += 25;
    else if (marker.startsWith('vite.config')) score += 25;
    else if (marker === '.git') score += 20;
    else if (marker.endsWith('lock.yaml') || marker.endsWith('lock.json') || marker.endsWith('lockb')) score += 10;
    else score += 5;
  }

  return Math.min(score, 100);
}

function detectPackageManager(markers: string[]): ProjectDetectionResult['packageManager'] {
  if (markers.includes('pnpm-lock.yaml')) return 'pnpm';
  if (markers.includes('yarn.lock')) return 'yarn';
  if (markers.includes('bun.lockb')) return 'bun';
  if (markers.includes('package-lock.json')) return 'npm';
  if (markers.includes('package.json')) return 'npm';

  return undefined;
}

function detectFramework(markers: string[]): string | undefined {
  if (markers.some((marker) => marker.startsWith('next.config'))) return 'Next.js';
  if (markers.some((marker) => marker.startsWith('vite.config'))) return 'Vite';
  return undefined;
}

function detectTestFramework(markers: string[]): string | undefined {
  if (markers.some((marker) => marker.startsWith('playwright.config'))) return 'Playwright';
  if (markers.some((marker) => marker.startsWith('cypress.config'))) return 'Cypress';
  return undefined;
}

export function detectProjectRoot(startDir = process.cwd()): ProjectDetectionResult {
  let currentDir = path.resolve(startDir);
  const homeDir = os.homedir();

  let bestMatch: ProjectDetectionResult = {
    isProject: false,
    root: null,
    confidence: 0,
    markers: [],
  };

  while (true) {
    const markers = getMarkers(currentDir);
    const confidence = scoreMarkers(markers);

    if (confidence > bestMatch.confidence) {
      bestMatch = {
        isProject: confidence >= 40,
        root: confidence >= 40 ? currentDir : null,
        confidence,
        markers,
        packageManager: detectPackageManager(markers),
        framework: detectFramework(markers),
        testFramework: detectTestFramework(markers),
      };
    }

    const parentDir = path.dirname(currentDir);

    if (
      parentDir === currentDir ||
      currentDir === homeDir
    ) {
      break;
    }

    currentDir = parentDir;
  }

  return bestMatch;
}