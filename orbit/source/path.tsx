import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveUserPath(input: string, baseDir = process.cwd()) {
  let rawPath = input.trim();

  if (!rawPath) {
    throw new Error('Path is empty');
  }

  // Remove surrounding quotes: "~/Project" or '~/Project'
  rawPath = rawPath.replace(/^["']|["']$/g, '');

  // Expand ~ to home directory
  if (rawPath === '~') {
    rawPath = os.homedir();
  } else if (rawPath.startsWith('~/')) {
    rawPath = path.join(os.homedir(), rawPath.slice(2));
  }

  // Convert relative path to absolute path
  const absolutePath = path.isAbsolute(rawPath)
    ? rawPath
    : path.resolve(baseDir, rawPath);

  return absolutePath;
}

export function validateProjectPath(input: string, baseDir = process.cwd()) {
  const resolvedPath = resolveUserPath(input, baseDir);

  if (!fs.existsSync(resolvedPath)) {
    return {
      ok: false as const,
      path: resolvedPath,
      error: 'Path does not exist',
    };
  }

  const stat = fs.statSync(resolvedPath);

  if (!stat.isDirectory()) {
    return {
      ok: false as const,
      path: resolvedPath,
      error: 'Path is not a directory',
    };
  }

  return {
    ok: true as const,
    path: resolvedPath,
  };
}