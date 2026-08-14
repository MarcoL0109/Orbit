#!/usr/bin/env node

import React from 'react';
import {render} from 'ink';
import {Command} from 'commander';
import {App} from './app.js';
import {cleanupTrackedProcesses} from './projects/processTracking.js';
import {runCi} from './ci.js';
import 'dotenv/config.js';

// Safety net for abrupt termination in the interactive UI (Ctrl-C, a parent
// process killing this one) — /exit's own handler covers the graceful path,
// but a dev server run_command started shouldn't be left orphaned just
// because the CLI itself didn't shut down cleanly. Only installed for the
// interactive paths below (not --ci) — runCi installs its own signal
// handling instead, so a cancelled CI run gets a chance to abort in flight
// and let its browser worker close, rather than being killed out from under
// it here before that can happen.
function installInteractiveSignalHandling(): void {
	for (const signal of ['SIGINT', 'SIGTERM'] as const) {
		process.on(signal, () => {
			cleanupTrackedProcesses();
			process.exit(0);
		});
	}
}

const program = new Command();

program
	.name('orbit')
	.description('Orbit - AI QA agent for E2E testing')
	.version('0.1.0');

program
	.argument('[prompt...]', 'What you want Orbit to test')
	.option(
		'--ci',
		'Run headlessly for CI: execute once, print the result, exit with a pass/fail status code — no interactive UI',
	)
	.action(async (promptParts: string[], options: {ci?: boolean}) => {
		const prompt = promptParts.join(' ').trim();

		if (options.ci) {
			if (!prompt) {
				console.error(
					'orbit --ci requires a feature description, e.g. orbit "user can sign up" --ci',
				);
				process.exit(2);
			}

			// A quoted description arrives as a single shell word — commander
			// only ever sees more than one promptParts entry when the shell
			// split it apart, which happens exactly when it wasn't quoted.
			// This can't be detected after the fact for a genuinely
			// single-word description (quoted or not, it looks identical by
			// the time Node sees it) — nothing to enforce there anyway, since
			// there's no space for the shell to have split on.
			if (promptParts.length > 1) {
				console.error(
					`orbit --ci requires the feature description to be a single quoted argument — it arrived as ${promptParts.length} separate words instead, which means it wasn't quoted. Wrap it in quotes:\n  orbit "${prompt}" --ci`,
				);
				process.exit(2);
			}

			const exitCode = await runCi(prompt);
			process.exit(exitCode);
		}

		installInteractiveSignalHandling();
		render(<App initialPrompt={prompt || undefined} />);
	});

program
	.command('scan')
	.description('Scan the current project')
	.action(() => {
		installInteractiveSignalHandling();
		render(<App initialPrompt="Scan this project" />);
	});

program
	.command('init')
	.description('Create Orbit config in the current project')
	.action(() => {
		installInteractiveSignalHandling();
		render(<App initialPrompt="Initialize Orbit config" />);
	});

program.parse();
