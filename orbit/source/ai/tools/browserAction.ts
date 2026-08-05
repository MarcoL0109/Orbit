import type { BrowserWorkerResponse } from '../browserWorker.js';
import type { ToolDefinition, ToolResult } from './types.js';

export type BrowserActionArgs = {
    action: 'navigate' | 'click' | 'fill' | 'snapshot' | 'reset';
    url: string | null;
    selector: string | null;
    value: string | null;
};

function toToolResult(response: BrowserWorkerResponse): ToolResult<BrowserWorkerResponse> {
    return response.ok ? {ok: true, data: response} : {ok: false, error: response.error};
}

// 'close' is deliberately not an agent-facing action — the browser's
// lifecycle belongs to the run (see agent.ts's finally), not to the model;
// there's no legitimate reason for the agent to end it mid-run.
export const browserActionTool: ToolDefinition<BrowserActionArgs, BrowserWorkerResponse> = {
    name: 'browser_action',
    description:
        'Interact with a real, running browser to ground exploration in what actually renders, instead of guessing from source. "navigate" loads a URL. "click" and "fill" act on a Playwright locator string (e.g. role=button[name="Submit"], text=..., or CSS) and, like navigate, return the resulting accessibility snapshot only if the page actually changed. "snapshot" always returns the current accessibility tree regardless of change, for an explicit re-check. "reset" starts a clean browser context (fresh cookies/storage) — call it when starting exploration for a NEW feature, never between pages within the same feature\'s flow, since a multi-page flow depends on staying in the same context.',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['navigate', 'click', 'fill', 'snapshot', 'reset'],
                description: 'Which browser operation to perform.',
            },
            url: {
                type: ['string', 'null'],
                description: 'URL to navigate to. Required for "navigate", null for every other action.',
            },
            selector: {
                type: ['string', 'null'],
                description: 'Playwright locator string identifying the element. Required for "click" and "fill", null otherwise.',
            },
            value: {
                type: ['string', 'null'],
                description: 'Text to type into the element. Required for "fill", null otherwise.',
            },
        },
        required: ['action', 'url', 'selector', 'value'],
    },
    execute: async (args, context) => {
        const worker = await context.getBrowserWorker();

        switch (args.action) {
            case 'navigate':
                if (!args.url) return {ok: false, error: '"navigate" requires a url'};
                return toToolResult(await worker.send({action: 'navigate', url: args.url}));

            case 'click':
                if (!args.selector) return {ok: false, error: '"click" requires a selector'};
                return toToolResult(await worker.send({action: 'click', selector: args.selector}));

            case 'fill':
                if (!args.selector) return {ok: false, error: '"fill" requires a selector'};
                if (args.value === null) return {ok: false, error: '"fill" requires a value'};
                return toToolResult(await worker.send({action: 'fill', selector: args.selector, value: args.value}));

            case 'snapshot':
                return toToolResult(await worker.send({action: 'snapshot'}));

            case 'reset':
                return toToolResult(await worker.send({action: 'reset'}));
        }
    },
};
