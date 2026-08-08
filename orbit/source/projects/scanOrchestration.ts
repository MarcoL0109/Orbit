import type React from 'react';
import { scanProject, type ProjectMap } from './scan.js';
import { readOrbitConfig, writeOrbitConfig } from '../init/config.js';
import { isGraphifyAvailable, installGraphify, runGraphifyScan } from './graphify.js';
import type { Message } from '../commands/context.js';

export type ScanOrchestrationDeps = {
    requestApproval: (description: string) => Promise<boolean>;
    requestScanMode: () => Promise<'regex' | 'graphify'>;
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
};

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
): Promise<ProjectMap> {
    const projectMap = await scanProject(projectRoot);

    const orbitConfig = readOrbitConfig(projectRoot);
    if (!orbitConfig) {
        // Not initialized yet (or config unreadable) — nothing to persist
        // a choice into, so just behave exactly as scanProject always has.
        return projectMap;
    }

    // == not === : a project initialized before scanMode existed has no
    // such field in its config.json at all (undefined), not literally
    // null — both mean "not yet chosen" and should prompt the same way.
    if (orbitConfig.scanMode == null) {
        await resolveScanModeChoice(projectRoot, orbitConfig, deps);
        return projectMap;
    }

    if (orbitConfig.scanMode === 'graphify') {
        runGraphifyAndReport(projectRoot, deps);
    }

    return projectMap;
}

async function resolveScanModeChoice(
    projectRoot: string,
    orbitConfig: NonNullable<ReturnType<typeof readOrbitConfig>>,
    deps: ScanOrchestrationDeps,
): Promise<void> {
    const mode = await deps.requestScanMode();

    if (mode === 'regex') {
        writeOrbitConfig(projectRoot, {...orbitConfig, scanMode: 'regex'});
        return;
    }

    // mode === 'graphify'
    if (!isGraphifyAvailable()) {
        const approved = await deps.requestApproval(
            'Install graphify (uv tool install graphifyy) to build a deeper AST-based project knowledge graph?',
        );

        if (!approved) {
            postMessage(deps, 'Skipped — using the built-in regex scan for now. Run /scan again any time to reconsider graphify.', 'gray');
            return; // scanMode stays null — asked again next scan, not locked into regex.
        }

        const installResult = installGraphify();
        if (!installResult.installed) {
            postMessage(deps, `Couldn't install graphify: ${installResult.reason}\nUsing the built-in regex scan for now.`, 'yellow');
            return; // scanMode stays null here too, for the same reason.
        }

        postMessage(deps, 'graphify installed.', 'green');
    }

    writeOrbitConfig(projectRoot, {...orbitConfig, scanMode: 'graphify'});
    runGraphifyAndReport(projectRoot, deps);
}

function runGraphifyAndReport(projectRoot: string, deps: ScanOrchestrationDeps): void {
    const result = runGraphifyScan(projectRoot);

    if (result.ok) {
        postMessage(deps, `Knowledge graph ${result.mode === 'extract' ? 'built' : 'updated'}: ${result.summary}`, 'green');
    } else {
        // Non-fatal by design, same as scanProject's own callers treating
        // a scan failure as non-blocking — the regex-based ProjectMap this
        // function already returned is still perfectly usable on its own.
        postMessage(deps, `graphify scan failed: ${result.error}`, 'yellow');
    }
}

function postMessage(deps: ScanOrchestrationDeps, content: string, color: string): void {
    deps.setMessages((prev) => [...prev, {role: 'agent', content, color}]);
}
