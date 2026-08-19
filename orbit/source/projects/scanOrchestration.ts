import type React from 'react';
import {readOrbitConfig, writeOrbitConfig} from '../init/config.js';
import type {Message} from '../commands/context.js';
import {scanProject, type ProjectMap} from './scan.js';
import {
	isGraphifyAvailable,
	installGraphify,
	runGraphifyScan,
} from './graphify.js';

export type ScanOrchestrationDeps = {
	requestApproval: (description: string) => Promise<boolean>;
	requestScanMode: () => Promise<'regex' | 'graphify'>;
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
};

// The final outcome of a graphify build/update, as data rather than a
// posted message — 'skipped' whenever graphify never actually ran (regex
// mode, or a scan-mode choice that stayed unresolved). Callers decide how
// (or whether) to show this: /scan, /coverage, and the pre-test rescan post
// it as its own message exactly as before; /init instead folds it into its
// single combined "Orbit initialized this project" message. The
// interactive scan-mode-selection messages ("Skipped — using regex...",
// "graphify installed.", an install failure) stay auto-posted from inside
// this module regardless of caller — those are about the CHOOSING process
// itself, not this result, and every caller wants them shown inline as
// they happen.
export type GraphifyOutcome =
	| {status: 'skipped'}
	| {status: 'success'; mode: 'extract' | 'update'; summary: string}
	| {status: 'failed'; error: string};

export type ScanOrchestrationResult = {
	projectMap: ProjectMap;
	graphifyOutcome: GraphifyOutcome;
};

// Formats a GraphifyOutcome for display, or null when there's nothing worth
// showing (skipped) — callers post this themselves via their own
// setMessages, however fits their own message flow.
export function graphifyOutcomeMessage(
	outcome: GraphifyOutcome,
): {content: string; color: string} | null {
	if (outcome.status === 'success') {
		return {
			content: `Knowledge graph ${
				outcome.mode === 'extract' ? 'built' : 'updated'
			}: ${outcome.summary}`,
			color: 'green',
		};
	}

	if (outcome.status === 'failed') {
		// Non-fatal by design, same as scanProject's own callers treating a
		// scan failure as non-blocking — the regex-based ProjectMap is
		// still perfectly usable on its own.
		return {content: `graphify scan failed: ${outcome.error}`, color: 'yellow'};
	}

	return null;
}

// Every scanProject() call site (init's auto-scan, /scan, the pre-test
// rescan, /coverage) goes through this instead of calling scanProject
// directly. scanProject's own ProjectMap is always built regardless — it's
// what the rest of the app (feature classification, coverage) depends on —
// graphify only ever runs *in addition to* it, never in place of it, since
// its output has a completely different shape and nothing downstream reads
// it yet.
export async function scanProjectWithModeSelection(
	projectRoot: string,
	deps: ScanOrchestrationDeps,
): Promise<ScanOrchestrationResult> {
	const projectMap = await scanProject(projectRoot);

	const orbitConfig = readOrbitConfig(projectRoot);
	if (!orbitConfig) {
		// Not initialized yet (or config unreadable) — nothing to persist
		// a choice into, so just behave exactly as scanProject always has.
		return {projectMap, graphifyOutcome: {status: 'skipped'}};
	}

	// == not === : a project initialized before scanMode existed has no
	// such field in its config.json at all (undefined), not literally
	// null — both mean "not yet chosen" and should prompt the same way.
	if (orbitConfig.scanMode == null) {
		const graphifyOutcome = await resolveScanModeChoice(
			projectRoot,
			orbitConfig,
			deps,
		);
		return {projectMap, graphifyOutcome};
	}

	if (orbitConfig.scanMode === 'graphify') {
		return {projectMap, graphifyOutcome: runGraphifyAndGetOutcome(projectRoot)};
	}

	return {projectMap, graphifyOutcome: {status: 'skipped'}};
}

async function resolveScanModeChoice(
	projectRoot: string,
	orbitConfig: NonNullable<ReturnType<typeof readOrbitConfig>>,
	deps: ScanOrchestrationDeps,
): Promise<GraphifyOutcome> {
	const mode = await deps.requestScanMode();

	if (mode === 'regex') {
		writeOrbitConfig(projectRoot, {...orbitConfig, scanMode: 'regex'});
		return {status: 'skipped'};
	}

	// Mode === 'graphify'
	if (!isGraphifyAvailable()) {
		const approved = await deps.requestApproval(
			'Install graphify (uv tool install graphifyy) to build a deeper AST-based project knowledge graph?',
		);

		if (!approved) {
			postMessage(
				deps,
				'Skipped — using the built-in regex scan for now. Run /scan again any time to reconsider graphify.',
				'gray',
			);
			return {status: 'skipped'}; // ScanMode stays null — asked again next scan, not locked into regex.
		}

		const installResult = installGraphify();
		if (!installResult.installed) {
			postMessage(
				deps,
				`Couldn't install graphify: ${installResult.reason}\nUsing the built-in regex scan for now.`,
				'yellow',
			);
			return {status: 'skipped'}; // ScanMode stays null here too, for the same reason.
		}

		postMessage(deps, 'graphify installed.', 'green');
	}

	writeOrbitConfig(projectRoot, {...orbitConfig, scanMode: 'graphify'});
	return runGraphifyAndGetOutcome(projectRoot);
}

export function runGraphifyAndGetOutcome(projectRoot: string): GraphifyOutcome {
	const result = runGraphifyScan(projectRoot);

	return result.ok
		? {status: 'success', mode: result.mode, summary: result.summary}
		: {status: 'failed', error: result.error};
}

function postMessage(
	deps: ScanOrchestrationDeps,
	content: string,
	color: string,
): void {
	deps.setMessages(previous => [...previous, {role: 'agent', content, color}]);
}
