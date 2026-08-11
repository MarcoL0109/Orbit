// A session-lifetime singleton, not something threaded through React state
// or CommandContext — it needs to be reachable from a raw process signal
// handler (cli.tsx), which lives outside any component, so a shared module
// is simpler than prop-drilling a ref through the UI layer for this.
const trackedPids = new Set<number>();

export function trackProcess(pid: number): void {
	trackedPids.add(pid);
}

// Best-effort, not something callers need to await or check — a PID that's
// already exited (the common case: most run_command calls are one-shot
// things like `uv sync` that finish long before cleanup ever runs) just
// throws on kill() and is skipped. Only genuinely still-running background
// processes (a dev server started with a trailing &) are actually there to
// kill by the time this runs.
export function cleanupTrackedProcesses(): void {
	for (const pid of trackedPids) {
		try {
			// Negative PID kills the whole process group — necessary
			// because a bare `&` backgrounds a grandchild that detaches
			// from Node's direct child reference, but stays in the same
			// POSIX process group as long as that child was itself spawned
			// with `detached: true` (see runCommand.ts). Killing just the
			// direct child's own PID would miss it entirely.
			process.kill(-pid, 'SIGTERM');
		} catch {
			// Already exited — nothing to do.
		}
	}

	trackedPids.clear();
}
