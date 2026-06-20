#!/usr/bin/env node

import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import { App } from './app.js';

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