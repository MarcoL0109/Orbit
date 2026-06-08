#!/usr/bin/env node
import React from 'react';
import {render} from 'ink';
import meow from 'meow';
import App from './app.js';

const cli = meow(
	`
	Usage
	  $ orbit

	Options
	  --endpoint, -e  Specify a custom Python backend URL [Default: http://localhost:8000]

	Examples
	  $ orbit
	  $ orbit --endpoint=http://localhost:5000
	`,
	{
		importMeta: import.meta,
		flags: {
			endpoint: {
				type: 'string',
				shortFlag: 'e',
				default: 'http://localhost:8000'
			},
		},
	},
);

// Enter the alternative screen buffer to create a clean "app" experience
process.stdout.write('\x1b[?1049h');

const { waitUntilExit } = render(<App endpoint={cli.flags.endpoint} />);

// When the Ink application exits, cleanly restore the user's terminal screen
waitUntilExit().then(() => {
	process.stdout.write('\x1b[?1049l');
});