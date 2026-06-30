// src/commands/types.ts

import type React from 'react';

export type Message = {
    role: 'user' | 'agent' | 'system';
    content: string;
};

export type CommandContext = {
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
    setQuery: React.Dispatch<React.SetStateAction<string>>;
    setIsThinking: React.Dispatch<React.SetStateAction<boolean>>;
};