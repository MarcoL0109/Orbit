import type React from 'react';

export type Message = {
	role: 'user' | 'agent' | 'system';
	content: string;
	color?: string;
	dim?: boolean;
};

export type ProjectOptions = {
	label: string;
	value: string;
};

export type ProjectInfo = {
	isProject: boolean;
	root: string | null;
	confidence: number;
	markers: string[];
	framework?: string;
	packageManager?: string;
	testFramework?: string;
	hasOrbitFolder?: boolean;
	// Blind mode: root is Orbit's own storage workspace, not a detected
	// codebase, and targetUrl is the live app Orbit explores via the
	// browser instead of reading source for.
	blind?: boolean;
	targetUrl?: string;
};

export type CommandContext = {
	setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
	setQuery: React.Dispatch<React.SetStateAction<string>>;
	setIsThinking: React.Dispatch<React.SetStateAction<boolean>>;
	setSelectProjectMode: React.Dispatch<React.SetStateAction<boolean>>;
	setProjectOptions: React.Dispatch<React.SetStateAction<ProjectOptions[]>>;
	setIsInitting: React.Dispatch<React.SetStateAction<boolean>>;
	project: ProjectInfo | null;
	isThinking: boolean;
	constructProjectOptions: () => ProjectOptions[];
	setProject: React.Dispatch<React.SetStateAction<ProjectInfo | null>>;
	setCheckName: React.Dispatch<React.SetStateAction<boolean>>;
	setConfirmName: React.Dispatch<React.SetStateAction<string>>;
	// The /init path-confirmation step: shown when /init is run with no
	// explicit path argument, pre-filled with an auto-detected (or cwd)
	// suggestion the user can accept as-is or edit before it's resolved via
	// detectProjectAtPath.
	setCheckInitPath: React.Dispatch<React.SetStateAction<boolean>>;
	setConfirmInitPath: React.Dispatch<React.SetStateAction<string>>;
	startAbortableTask: () => AbortController;
	clearAbortableTask: () => void;
	abortCurrentTask: () => boolean;
	setConfirmDeinit: React.Dispatch<React.SetStateAction<boolean>>;
	requestApproval: (description: string) => Promise<boolean>;
	requestInput: (prompt: string) => Promise<string | null>;
	// Asked once per project, the first time a scan happens and no choice
	// has been persisted yet — see scanOrchestration.ts.
	requestScanMode: () => Promise<'regex' | 'graphify'>;
	// Resolves once the user picks Success or Failure — see confirm_outcome.
	requestOutcomeConfirmation: (
		feature: string,
		whatWasDone: string,
		output: string,
	) => Promise<'success' | 'failure'>;
	// Generic N-way select, resolving to the chosen option's value — used by
	// /config for both picking which field to edit and picking a new value
	// for an enum field. Deliberately separate from the bespoke
	// pendingApproval/pendingScanMode/pendingOutcomeConfirmation prompts
	// (each has its own fixed option set and wording baked in); this one
	// exists because /config needs two different N-way choices, not because
	// those existing ones should be rebuilt on top of it.
	requestSelect: (
		prompt: string,
		options: Array<{label: string; value: string}>,
	) => Promise<string>;
	setAgentActivity: React.Dispatch<React.SetStateAction<string | null>>;
	// The blind-mode storage-path confirmation step: shown when /blind is
	// given a URL that isn't already a known blind project, pre-filled with
	// a suggested workspace path the user can accept or edit before
	// anything is written — same shape as /init's checkInitPath/
	// confirmInitPath, just for a URL instead of a filesystem root.
	setCheckBlindPath: React.Dispatch<React.SetStateAction<boolean>>;
	setConfirmBlindPath: React.Dispatch<React.SetStateAction<string>>;
	setPendingBlindUrl: React.Dispatch<React.SetStateAction<string>>;
	// Keyed by project root, not a single flag — switching projects (/switch)
	// shouldn't let one project's confirmed-ready state apply to another.
	// Set once per project per session; never cleared or re-checked after
	// that (see the /test wiring) — a crashed dev server mid-session means
	// the next /test just fails against an unreachable baseUrl rather than
	// auto-recovering, a deliberate tradeoff, not an oversight.
	isEnvironmentReady: (projectRoot: string) => boolean;
	markEnvironmentReady: (projectRoot: string) => void;
};
