#!/usr/bin/env node

import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { App } from './app.js';
import { cleanupTrackedProcesses } from './projects/processTracking.js';
import 'dotenv/config';

// Safety net for abrupt termination (Ctrl-C, a parent process killing this
// one) — /exit's own handler covers the graceful path, but a dev server
// run_command started shouldn't be left orphaned just because the CLI
// itself didn't shut down cleanly.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    cleanupTrackedProcesses();
    process.exit(0);
  });
}

const program = new Command();

program
  .name('orbit')
  .description('Orbit - AI QA agent for E2E testing')
  .version('0.1.0');

program
  .argument('[prompt...]', 'What you want Orbit to test')
  .action((promptParts: string[]) => {
    const initialPrompt = promptParts.join(' ').trim();

    render(<App initialPrompt={initialPrompt || undefined} />);
  });

program
  .command('scan')
  .description('Scan the current project')
  .action(() => {
    render(<App initialPrompt="Scan this project" />);
  });

program
  .command('init')
  .description('Create Orbit config in the current project')
  .action(() => {
    render(<App initialPrompt="Initialize Orbit config" />);
  });

program.parse();