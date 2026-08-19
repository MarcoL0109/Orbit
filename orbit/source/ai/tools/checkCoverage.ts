import {readProjectMap} from '../../projects/scan.js';
import {
	computeCoverage,
	formatCoverageSummary,
	describeCoverageEntry,
} from '../../projects/coverage.js';
import type {CommandContext} from '../../commands/context.js';
import type {ToolDefinition} from './types.js';

export type CheckCoverageData = {
	content: string;
};

// Works off whatever project map is already on disk (the same one
// summarized into this agent's own system prompt) rather than forcing a
// fresh scan — refresh_project_scan is the tool for that, kept separate so
// this stays a cheap, always-available read. Read-only, never asks for
// approval.
export const checkCoverageTool: ToolDefinition<
	Record<string, never>,
	CheckCoverageData,
	{projectRoot: string; setMessages: CommandContext['setMessages']}
> = {
	name: 'check_coverage',
	description:
		"Show which routes and components don't have a matching test yet — the same report /coverage shows. Read-only, never asks for approval.",
	parameters: {type: 'object', properties: {}, required: []},
	async execute(_args, context) {
		const projectMap = readProjectMap(context.projectRoot);
		if (!projectMap) {
			const content =
				'No project index yet — nothing has been scanned for this project. Use refresh_project_scan first.';
			context.setMessages(previous => [...previous, {role: 'agent', content}]);
			return {ok: true, data: {content}};
		}

		const report = computeCoverage(projectMap, context.projectRoot);
		const lines = [
			formatCoverageSummary(report),
			...report.routes.map(entry => describeCoverageEntry(entry)),
			...report.components.map(entry => describeCoverageEntry(entry)),
		];
		const content = lines.join('\n');

		context.setMessages(previous => [...previous, {role: 'agent', content}]);

		return {ok: true, data: {content}};
	},
};
