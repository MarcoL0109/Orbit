import fs from 'node:fs';
import path from 'node:path';

// A project's own Orbit folder is named '.orbit' for a normal project
// (sitting alongside real source — the dot signals "tool state, not your
// code" to editors/search) or 'orbit' for a blind one (nothing else shares
// that workspace, so there's nothing for the dot to distinguish it from,
// and hiding the one thing a blind-mode user is meant to inspect defeats
// the point). Resolved by checking which one actually exists — every
// caller here reads/writes into an ALREADY-initialized project, so this
// never has to guess; only initOrbitProject decides which one to create.
export const NORMAL_ORBIT_DIR_NAME = '.orbit';
export const BLIND_ORBIT_DIR_NAME = 'orbit';

export function resolveOrbitDirName(
	projectRoot: string,
): typeof NORMAL_ORBIT_DIR_NAME | typeof BLIND_ORBIT_DIR_NAME {
	if (fs.existsSync(path.join(projectRoot, BLIND_ORBIT_DIR_NAME))) {
		return BLIND_ORBIT_DIR_NAME;
	}

	return NORMAL_ORBIT_DIR_NAME;
}

export function getOrbitDir(projectRoot: string): string {
	return path.join(projectRoot, resolveOrbitDirName(projectRoot));
}
