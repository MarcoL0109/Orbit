import {readOrbitConfig} from '../../init/config.js';
import {
	scanProject,
	writeProjectMap,
	formatScanResult,
} from '../../projects/scan.js';
import {
	runGraphifyAndGetOutcome,
	graphifyOutcomeMessage,
} from '../../projects/scanOrchestration.js';
import type {CommandContext} from '../../commands/context.js';
import type {ToolDefinition} from './types.js';

export type RefreshProjectScanData = {
	content: string;
};

// Always runs the plain regex scan (scanProject never needs a mode choice)
// and, only if graphify mode was already chosen for this project, also
// refreshes the graph — deliberately never triggers the interactive
// "regex or graphify?" picker /scan's own first-ever run can, since that
// choice shouldn't suddenly appear in the middle of answering a question.
// Read-only in the sense that matters here (no test files touched, no live
// app affected) — writes only .orbit/index/*, never asks for approval.
export const refreshProjectScanTool: ToolDefinition<
	Record<string, never>,
	RefreshProjectScanData,
	{projectRoot: string; setMessages: CommandContext['setMessages']}
> = {
	name: 'refresh_project_scan',
	description:
		'Rescan the project for routes, components, and tests, refreshing the code index (and the knowledge graph, if this project already uses graphify) — the non-interactive part of what /scan does. Use this when you suspect the index is stale (e.g. checking coverage right after code changed). Never asks for approval.',
	parameters: {type: 'object', properties: {}, required: []},
	async execute(_args, context) {
		const projectMap = await scanProject(context.projectRoot);
		const projectMapPath = writeProjectMap(context.projectRoot, projectMap);

		const lines = [formatScanResult(projectMap, projectMapPath)];

		const orbitConfig = readOrbitConfig(context.projectRoot);
		if (orbitConfig?.scanMode === 'graphify') {
			const graphifyMessage = graphifyOutcomeMessage(
				runGraphifyAndGetOutcome(context.projectRoot),
			);
			if (graphifyMessage) {
				lines.push(graphifyMessage.content);
			}
		}

		const content = lines.join('\n\n');
		context.setMessages(previous => [...previous, {role: 'agent', content}]);

		return {ok: true, data: {content}};
	},
};
