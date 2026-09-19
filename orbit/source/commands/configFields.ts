import type {OrbitConfig} from '../init/config.js';

// Split out of commands.ts so set_config (source/ai/tools/setConfig.ts) can
// import this without pulling in the whole commands module — commands.ts
// imports runAskAgent (askAgent.ts), which imports setConfig.ts, so
// setConfig.ts importing back from commands.ts directly created a circular
// import that broke at runtime (CONFIG_FIELDS accessed before its own
// module finished initializing). Same fix already used for
// verifiedSelectors.ts (agent.ts <-> writeTestFile.ts): pull the shared
// piece out to a module neither side needs to import the other through.

// /config's editable fields — deliberately a subset of OrbitConfig.
// dockerComposeFile and dockerComposeHasHealthchecks are auto-detected
// facts, not preferences; testDir/manualTestDir are conventions other code
// paths assume are stable. scanMode IS included despite already having its
// own flow (/scan's picker) — that picker only ever fires once, while
// scanMode is still null; once it's set (correctly or by mistake, e.g. a
// stray keypress during the picker) there is otherwise no way to change it
// short of deleting .orbit/config.json by hand or a destructive
// /deinit + /init. Picking a new value here only persists the choice —
// the actual graphify build/install still only happens on the next real
// scan, exactly as if /scan's picker had been answered this way.
export type ConfigFieldDescriptor =
	| {key: 'approvalMode'; label: string; kind: 'enum'; options: string[]}
	| {key: 'writeMode'; label: string; kind: 'enum'; options: string[]}
	| {key: 'defaultBrowser'; label: string; kind: 'enum'; options: string[]}
	| {key: 'scanMode'; label: string; kind: 'enum'; options: string[]}
	| {key: 'baseUrl'; label: string; kind: 'text'; nullable: false}
	| {key: 'testCommand'; label: string; kind: 'text'; nullable: true}
	| {key: 'environmentSetupRoot'; label: string; kind: 'text'; nullable: true}
	| {key: 'maxRepairAttempts'; label: string; kind: 'number'}
	| {key: 'devCommands'; label: string; kind: 'csv'}
	| {key: 'headed'; label: string; kind: 'boolean'}
	| {key: 'testingModel'; label: string; kind: 'text'; nullable: false}
	| {key: 'chatModel'; label: string; kind: 'text'; nullable: false}
	| {
			key: 'environmentSetupModel';
			label: string;
			kind: 'text';
			nullable: false;
	  }
	| {key: 'classificationModel'; label: string; kind: 'text'; nullable: false}
	| {
			key: 'promptRecommendationModel';
			label: string;
			kind: 'text';
			nullable: false;
	  }
	| {key: 'brdPath'; label: string; kind: 'text'; nullable: true};

export const CONFIG_FIELDS: ConfigFieldDescriptor[] = [
	{
		key: 'approvalMode',
		label: 'Approval mode',
		kind: 'enum',
		options: ['ask', 'always'],
	},
	{
		key: 'writeMode',
		label: 'Write mode',
		kind: 'enum',
		options: ['ask', 'always'],
	},
	{
		key: 'defaultBrowser',
		label: 'Default browser',
		kind: 'enum',
		options: ['chromium', 'firefox', 'webkit'],
	},
	{
		key: 'scanMode',
		label: 'Scan mode',
		kind: 'enum',
		options: ['regex', 'graphify'],
	},
	{key: 'baseUrl', label: 'Base URL', kind: 'text', nullable: false},
	{key: 'testCommand', label: 'Test command', kind: 'text', nullable: true},
	{
		key: 'environmentSetupRoot',
		label: 'Environment setup root',
		kind: 'text',
		nullable: true,
	},
	{key: 'maxRepairAttempts', label: 'Max repair attempts', kind: 'number'},
	{key: 'devCommands', label: 'Dev commands', kind: 'csv'},
	{key: 'headed', label: 'Display browser window', kind: 'boolean'},
	{
		key: 'testingModel',
		label: 'Testing agent model',
		kind: 'text',
		nullable: false,
	},
	{key: 'chatModel', label: 'Chat agent model', kind: 'text', nullable: false},
	{
		key: 'environmentSetupModel',
		label: 'Environment setup agent model',
		kind: 'text',
		nullable: false,
	},
	{
		key: 'classificationModel',
		label: 'Feature classification model',
		kind: 'text',
		nullable: false,
	},
	{
		key: 'promptRecommendationModel',
		label: 'Prompt suggestion model',
		kind: 'text',
		nullable: false,
	},
	{
		key: 'brdPath',
		label: 'Business requirements doc path',
		kind: 'text',
		nullable: true,
	},
];

export function formatConfigFieldValue(
	config: OrbitConfig,
	field: ConfigFieldDescriptor,
): string {
	const value = config[field.key];
	// undefined alongside null: OrbitConfig types these fields as always
	// present, but a config.json written before a field existed won't have
	// the key at all — readOrbitConfig doesn't backfill, so this is the
	// only place that actually sees the gap.
	if (value === null || value === undefined) return '(none)';
	if (Array.isArray(value))
		return value.length > 0 ? value.join(', ') : '(none)';
	if (field.kind === 'boolean') return value ? 'Yes' : 'No';
	return String(value);
}
