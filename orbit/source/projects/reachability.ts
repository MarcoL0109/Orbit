import http from 'node:http';
import https from 'node:https';

// Any response at all counts as reachable — even a 404 or 500 means
// something is listening on that port, which is all this is meant to
// answer. Only a connection failure (or the timeout) counts as not-ready.
// A raw request rather than a library, since this is the only thing this
// module does.
export async function isReachable(
	url: string,
	timeoutMs = 2000,
): Promise<boolean> {
	return new Promise(resolve => {
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			resolve(false);
			return;
		}

		const client = target.protocol === 'https:' ? https : http;

		const request = client.get(target, {timeout: timeoutMs}, response => {
			response.resume(); // Drain, don't care about the body
			resolve(true);
		});

		// Destroy() after a timeout should itself emit 'error', but resolve
		// directly too rather than relying on that — a request that never
		// settles would otherwise hang this Promise forever.
		request.on('timeout', () => {
			request.destroy();
			resolve(false);
		});
		request.on('error', () => {
			resolve(false);
		});
	});
}

// A single isReachable check right after a service was just told to start
// produces real false negatives — backgrounding a command returns as soon
// as the shell detaches, not once the service has actually finished its own
// startup (a Next.js dev server binding its port after compiling can lag
// the command's own return by several seconds). Retrying over a short,
// bounded window absorbs a normal cold start without waiting anywhere near
// as long as the setup agent's own run just took.
export async function waitUntilReachable(
	url: string,
	options: {
		totalTimeoutMs?: number;
		intervalMs?: number;
		perAttemptTimeoutMs?: number;
	} = {},
): Promise<boolean> {
	const totalTimeoutMs = options.totalTimeoutMs ?? 10_000;
	const intervalMs = options.intervalMs ?? 1000;
	const perAttemptTimeoutMs = options.perAttemptTimeoutMs ?? 2000;
	const deadline = Date.now() + totalTimeoutMs;

	while (true) {
		if (await isReachable(url, perAttemptTimeoutMs)) return true;
		if (Date.now() >= deadline) return false;
		await new Promise(resolve => setTimeout(resolve, intervalMs));
	}
}
