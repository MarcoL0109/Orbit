import {spawn} from 'node:child_process';
import {trackProcess} from '../../projects/processTracking.js';
import type {
	EnvironmentSetupContext,
	ToolDefinition,
	ToolResult,
} from './types.js';

export type RunCommandArgs = {
	command: string;
	reason: string;
};

export type RunCommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
};

// A one-shot command that isn't backgrounded (no trailing &) is meant to
// run to completion, not stay attached — but "to completion" can genuinely
// take several minutes for a real first-time setup step (e.g. an Odoo
// module install with demo data). 120s was cutting those off mid-way,
// forcing a drop/recreate/retry cycle on every single run regardless of
// whether the command itself was correct — see the ai-erp-platform-2 live
// test that caught this. 300s is a judgment call, not a measured ceiling:
// generous enough for that kind of one-time op, still bounded so a
// genuinely wrong/hung command doesn't block the agent indefinitely.
const COMMAND_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 8000;

function truncate(text: string): string {
	return text.length > MAX_OUTPUT_CHARS
		? text.slice(0, MAX_OUTPUT_CHARS) + '\n...(truncated)'
		: text;
}

// The one genuinely dangerous tool in this codebase — every other tool is
// narrowly scoped (read_file only reads, write_test_file only writes inside
// testDir, browser_action only controls an isolated browser process); this
// can do anything a shell can do. No attempt is made to classify commands
// as safe or dangerous — that judgment isn't reliable to automate (a
// database-seeding command doesn't look any more dangerous than a harmless
// one at the text level), so every single call requires explicit approval
// instead, with no exceptions.
//
// A non-zero exit code is still ok:true — the agent needs to see stdout/
// stderr/exitCode to decide what to do next (retry, try something else,
// give up), the same way run_test's failures feed the testing agent's own
// repair reasoning rather than aborting the run outright. ok:false is only
// for the command never actually running at all (declined, or a spawn-level
// error).
export const runCommandTool: ToolDefinition<
	RunCommandArgs,
	RunCommandResult,
	EnvironmentSetupContext
> = {
	name: 'run_command',
	description:
		'Execute a shell command in the project root — e.g. to bring up infrastructure, install dependencies, run migrations, or start a service. Every call requires the user\'s explicit approval; they see the exact command and your stated reason before it runs. A command meant to keep running (a dev server, "docker compose up" without -d) must background itself (append &, use nohup, or a daemon/-d flag) so this call returns instead of hanging — it is expected to complete, not stay attached.',
	parameters: {
		type: 'object',
		properties: {
			command: {
				type: 'string',
				description:
					'The exact shell command to run, e.g. "docker compose up -d" or "uv run alembic upgrade head".',
			},
			reason: {
				type: 'string',
				description:
					'One sentence on why this command is needed right now, shown to the user alongside the command.',
			},
		},
		required: ['command', 'reason'],
	},
	async execute({command, reason}, context) {
		const approved = await context.requestApproval(
			`Run: ${command}\n(${reason})`,
		);
		if (!approved) {
			return {ok: false, error: 'User declined to run this command'};
		}

		return new Promise<ToolResult<RunCommandResult>>(resolve => {
			let child;
			try {
				child = spawn(command, {
					shell: true,
					cwd: context.projectRoot,
					signal: context.signal,
					// Makes the shell the leader of its own process group,
					// which a background grandchild it forks (via a
					// trailing &) stays part of even after this direct
					// child exits. That's what makes group-kill via
					// process.kill(-pid) able to reach it later — see
					// processTracking.ts's cleanup, the only way a
					// backgrounded dev server ever actually gets stopped.
					detached: true,
				});
			} catch (error) {
				resolve({
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
				return;
			}

			if (typeof child.pid === 'number') {
				trackProcess(child.pid);
				child.unref();
			}

			let stdout = '';
			let stderr = '';
			child.stdout?.on('data', chunk => {
				stdout += chunk;
			});
			child.stderr?.on('data', chunk => {
				stderr += chunk;
			});

			let settled = false;
			const timers: NodeJS.Timeout[] = [];
			const after = (ms: number, fn: () => void) => {
				timers.push(setTimeout(fn, ms));
			};

			const clearAllTimers = () => {
				for (const t of timers) clearTimeout(t);
			};

			// SIGTERM alone isn't reliable — a process proxying a remote
			// session (docker compose exec, ssh, etc.) can be mid-I/O and
			// simply not respond to it. Escalate to SIGKILL if it's still
			// alive shortly after, and force-resolve as a last resort even
			// past that — SIGKILL can't be caught or ignored so 'exit'
			// should always follow it, but this guarantees an absolute
			// ceiling on how long any single call can hang regardless.
			after(COMMAND_TIMEOUT_MS, () => {
				if (settled) return;
				try {
					child.kill('SIGTERM');
				} catch {
					/* Already gone */
				}

				after(5000, () => {
					if (settled) return;
					try {
						child.kill('SIGKILL');
					} catch {
						/* Already gone */
					}

					after(5000, () => {
						if (settled) return;
						settled = true;
						resolve({
							ok: true,
							data: {
								stdout: truncate(stdout),
								stderr: truncate(stderr),
								exitCode: null,
							},
						});
					});
				});
			});

			// 'exit' rather than 'close': close only fires once every stdio
			// stream is also closed, but a backgrounded long-running child
			// (a dev server started with a trailing &) inherits the same
			// stdout/stderr pipes from the shell that spawned it — those
			// pipes then never close as long as that process keeps running,
			// which is the whole point of backgrounding it. Waiting on
			// close would hang this call forever in exactly the case the
			// tool's own description tells the agent to use. A short delay
			// after exit lets any already-in-flight data events land before
			// stdout/stderr are read, without waiting on pipes tied to a
			// process this call was never meant to wait for.
			child.on('exit', exitCode => {
				if (settled) return;
				clearAllTimers();
				after(50, () => {
					if (settled) return;
					settled = true;
					resolve({
						ok: true,
						data: {
							stdout: truncate(stdout),
							stderr: truncate(stderr),
							exitCode,
						},
					});
				});
			});

			child.on('error', error => {
				if (settled) return;
				settled = true;
				clearAllTimers();
				resolve({
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		});
	},
};
