import type React from 'react';

export type Message = {
    role: 'user' | 'agent' | 'system';
    content: string;
    color?: string;
    dim?: boolean;
};

export type ProjectOptions = {
	label: string,
	value: string,
}

export type ProjectInfo = {
	isProject: boolean;
	root: string | null;
	confidence: number;
	markers: string[];
	framework?: string;
	packageManager?: string;
	testFramework?: string;
	hasOrbitFolder?: boolean;
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
    startAbortableTask: () => AbortController;
    clearAbortableTask: () => void;
    abortCurrentTask: () => boolean;
    setConfirmDeinit: React.Dispatch<React.SetStateAction<boolean>>;
    requestApproval: (description: string) => Promise<boolean>;
    requestInput: (prompt: string) => Promise<string | null>;
    // Asked once per project, the first time a scan happens and no choice
    // has been persisted yet — see scanOrchestration.ts.
    requestScanMode: () => Promise<'regex' | 'graphify'>;
    setAgentActivity: React.Dispatch<React.SetStateAction<string | null>>;
    // Keyed by project root, not a single flag — switching projects (/switch)
    // shouldn't let one project's confirmed-ready state apply to another.
    // Set once per project per session; never cleared or re-checked after
    // that (see the /test wiring) — a crashed dev server mid-session means
    // the next /test just fails against an unreachable baseUrl rather than
    // auto-recovering, a deliberate tradeoff, not an oversight.
    isEnvironmentReady: (projectRoot: string) => boolean;
    markEnvironmentReady: (projectRoot: string) => void;
};