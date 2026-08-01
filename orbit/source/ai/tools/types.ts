import type { OrbitConfig } from '../../init/config.js';

export type ToolResult<T = unknown> =
    | {ok: true; data: T}
    | {ok: false; error: string};

export type ToolContext = {
    projectRoot: string;
    orbitConfig: OrbitConfig;
    signal: AbortSignal;
    // Resolves once the user responds in the Ink UI. Only awaited when the
    // relevant OrbitConfig mode is 'ask' — tools decide when to call this,
    // the loop doesn't force it.
    requestApproval: (description: string) => Promise<boolean>;
};

// A minimal JSON Schema object — only what's needed to describe a tool's
// parameters to the model, not a general-purpose schema type.
//
// Tools are registered in strict mode (see toApiToolSchema), which the API
// enforces via constrained decoding — every property must be listed in
// `required`; there is no such thing as an omittable property. Represent an
// optional argument as a nullable type instead, e.g.
// `{type: ['string', 'null']}` with the name still present in `required`,
// and treat `null` as "not provided" in `execute`. See run_test's filePath.
export type JsonSchema = {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
};

export type ToolDefinition<Args = any, Data = any> = {
    name: string;
    description: string;
    parameters: JsonSchema;
    execute: (args: Args, context: ToolContext) => Promise<ToolResult<Data>>;
};
