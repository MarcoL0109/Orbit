import { createOpenAIClient, type ResponsesClient } from './client.js';

export type ClassifyFileFeaturesResult = {
    features: string[];
};

const CLASSIFICATION_SCHEMA = {
    type: 'object',
    properties: {
        features: {
            type: 'array',
            items: {type: 'string'},
            description:
                'Dotted feature paths this file implements, e.g. ["checkout", "checkout.payment"]. Empty array if the file is generic/shared and not tied to a specific product feature.',
        },
    },
    required: ['features'],
    additionalProperties: false,
};

// Single-shot, not agentic — this is pure classification, there's no action
// to take and nothing to iterate on, so it doesn't go through the tool-call
// loop in agent.ts. Failures here are handled by the caller (read_file
// piggybacks this as a side effect and must not fail the read itself if
// classification fails).
export async function classifyFileFeatures(
    filePath: string,
    content: string,
    client: ResponsesClient = createOpenAIClient(),
    signal?: AbortSignal,
): Promise<ClassifyFileFeaturesResult> {
    const response = await client.responses.create({
        model: 'gpt-5.2',
        instructions:
            'You are classifying a single source file by the product feature(s) it implements, for a QA test-coverage tool. Judge from the actual code and content, not just the filename. Use short, lowercase, dot-separated feature names — a broad feature and, where it genuinely applies, a more specific sub-feature (e.g. "checkout" and "checkout.payment"). If the file is generic/shared infrastructure with no specific feature (a utility, a layout wrapper, a config file), return an empty array rather than guessing.',
        input: `File: ${filePath}\n\n${content.slice(0, 12_000)}`,
        text: {
            format: {
                type: 'json_schema',
                name: 'feature_classification',
                schema: CLASSIFICATION_SCHEMA,
                strict: true,
            },
        },
    }, signal ? {signal} : undefined);

    try {
        const parsed = JSON.parse(response.output_text) as ClassifyFileFeaturesResult;
        return {features: Array.isArray(parsed.features) ? parsed.features : []};
    } catch {
        return {features: []};
    }
}
