import {
	readOrbitConfig,
	writeOrbitConfig,
	type OrbitConfig,
} from '../../init/config.js';
import {
	CONFIG_FIELDS,
	formatConfigFieldValue,
} from '../../commands/configFields.js';
import type {CommandContext} from '../../commands/context.js';
import type {ToolDefinition} from './types.js';

export type SetConfigArgs = {
	field: string;
	value: string;
};

export type SetConfigData = {
	field: string;
	newValue: string;
};

type SetConfigContext = CommandContext & {
	projectRoot: string;
};

// Deliberately narrower than the interactive /config flow: only the plain
// scalar fields in CONFIG_FIELDS, taking a value directly as a structured
// argument instead of walking the same per-type requestSelect/requestInput
// prompts a human steps through. Blind mode's own on/off toggle isn't a
// config field at all (it switches the active project entirely — see
// OrbitConfig.blind) and is intentionally not reachable here, same
// reasoning /switch itself is excluded from this whole tool set. Every
// call requires approval, no exceptions — this can change real safety
// properties of the system (approvalMode, writeMode), not just cosmetic
// settings.
export const setConfigTool: ToolDefinition<
	SetConfigArgs,
	SetConfigData,
	SetConfigContext
> = {
	name: 'set_config',
	description:
		'Change one project configuration field, same as picking it in /config. Every call asks the user for approval before it runs, with no exceptions. Does not support toggling blind mode — that starts a different project entirely, not a field edit.',
	parameters: {
		type: 'object',
		properties: {
			field: {
				type: 'string',
				enum: CONFIG_FIELDS.map(f => f.key),
				description: 'Which config field to change.',
			},
			value: {
				type: 'string',
				description:
					'The new value, as plain text — "true"/"false" for a boolean field, a comma-separated list for a csv field, an empty string to clear a nullable text field, otherwise the literal value.',
			},
		},
		required: ['field', 'value'],
	},
	async execute({field: fieldKey, value}, context) {
		const field = CONFIG_FIELDS.find(f => f.key === fieldKey);
		if (!field) {
			return {ok: false, error: `Unknown config field: ${fieldKey}`};
		}

		const orbitConfig = readOrbitConfig(context.projectRoot);
		if (!orbitConfig) {
			return {ok: false, error: 'Project is not initialized.'};
		}

		if (field.key === 'scanMode' && orbitConfig.blind) {
			return {
				ok: false,
				error: 'scanMode cannot be changed for a blind project — blind mode never scans.',
			};
		}

		let parsedValue: unknown;
		if (field.kind === 'boolean') {
			if (value !== 'true' && value !== 'false') {
				return {
					ok: false,
					error: `${field.label} is a boolean field — value must be "true" or "false", got "${value}".`,
				};
			}
			parsedValue = value === 'true';
		} else if (field.kind === 'enum') {
			if (!field.options.includes(value)) {
				return {
					ok: false,
					error: `${field.label} must be one of: ${field.options.join(
						', ',
					)} — got "${value}".`,
				};
			}
			parsedValue = value;
		} else if (field.kind === 'number') {
			const parsed = Number(value);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				return {
					ok: false,
					error: `${field.label} must be a positive integer, got "${value}".`,
				};
			}
			parsedValue = parsed;
		} else if (field.kind === 'csv') {
			parsedValue = value
				.split(',')
				.map(item => item.trim())
				.filter(Boolean);
		} else {
			const trimmed = value.trim();
			if (trimmed === '' && !field.nullable) {
				return {ok: false, error: `${field.label} can't be empty.`};
			}
			parsedValue = trimmed === '' ? null : trimmed;
		}

		const approved = await context.requestApproval(
			`Set ${field.label} to ${String(parsedValue)}?`,
		);
		if (!approved) {
			return {ok: false, error: 'User declined to change this setting'};
		}

		const nextConfig: OrbitConfig = {
			...orbitConfig,
			[field.key]: parsedValue,
		};
		writeOrbitConfig(context.projectRoot, nextConfig);

		const newValue = formatConfigFieldValue(nextConfig, field);
		context.setMessages(previous => [
			...previous,
			{
				role: 'agent',
				content: `${field.label} updated to ${newValue}`,
			},
		]);

		return {ok: true, data: {field: field.key, newValue}};
	},
};
