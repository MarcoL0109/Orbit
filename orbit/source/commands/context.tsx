// src/commands/types.ts

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
    setReInit: React.Dispatch<React.SetStateAction<boolean>>;
    project: ProjectInfo | null;
    constructProjectOptions: () => ProjectOptions[];
};