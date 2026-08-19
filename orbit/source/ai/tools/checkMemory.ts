import {readProjectMemory} from '../../init/memory.js';
import {summarizeMemory, type MemorySections} from '../agent.js';
import type {CommandContext} from '../../commands/context.js';
import type {ToolDefinition} from './types.js';

const SECTION_KEYS = [
	'overview',
	'decisions',
	'environment',
	'failures',
] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

export type CheckMemoryArgs = {
	sections: SectionKey[] | null;
};

export type CheckMemoryData = {
	content: string;
};

// Only projectRoot + setMessages — this is the read-only counterpart to
// /memory's own handler, reusing the exact same summarizeMemory formatting
// so the two never drift, and posting the same message a human running
// /memory would see rather than keeping it hidden from the transcript.
export const checkMemoryTool: ToolDefinition<
	CheckMemoryArgs,
	CheckMemoryData,
	{projectRoot: string; setMessages: CommandContext['setMessages']}
> = {
	name: 'check_memory',
	description:
		"Read this project's own documented memory (overview, decisions, conventions, environment setup, known failure patterns) — the same content /memory shows. Read-only, never asks for approval.",
	parameters: {
		type: 'object',
		properties: {
			sections: {
				type: ['array', 'null'],
				items: {type: 'string', enum: [...SECTION_KEYS]},
				description:
					'Which sections to include, or null for all of them (overview, decisions, environment, failures).',
			},
		},
		required: ['sections'],
	},
	async execute({sections}, context) {
		const include: MemorySections = sections
			? Object.fromEntries(
					SECTION_KEYS.map(key => [key, sections.includes(key)]),
			  )
			: {overview: true, decisions: true, environment: true, failures: true};

		const memory = readProjectMemory(context.projectRoot);
		const content = summarizeMemory(memory, include);

		context.setMessages(previous => [...previous, {role: 'agent', content}]);

		return {ok: true, data: {content}};
	},
};
