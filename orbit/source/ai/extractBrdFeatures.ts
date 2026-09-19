import {createOpenAIClient, type ResponsesClient} from './client.js';
import {recordUsage} from '../registry/usage.js';

export type BrdFeaturePriority = 'must' | 'should' | 'could' | 'unspecified';

export type BrdFeature = {
	// Short, lowercase, dot-separated — same convention classifyFileFeatures
	// already uses, so this joins against a written test's own declared
	// features (write_test_file's `features` argument) with plain string
	// equality, no separate matching logic needed.
	feature: string;
	// What this feature actually requires — becomes the auto-generated /test
	// prompt for this feature when running everything uncovered from the
	// BRD, so this needs to be substantive, not just a restated name.
	description: string;
	priority: BrdFeaturePriority;
	// The actual BRD text this was derived from — what makes the human
	// review step (showing the list before running anything) trustworthy
	// rather than a leap of faith.
	sourceExcerpt: string;
};

export type ExtractBrdFeaturesResult = {
	features: BrdFeature[];
};

const EXTRACTION_SCHEMA = {
	type: 'object',
	properties: {
		features: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					feature: {
						type: 'string',
						description:
							'Short, lowercase, dot-separated feature name, e.g. "checkout.payment".',
					},
					description: {
						type: 'string',
						description:
							'What this feature requires, phrased as something to test — specific enough to become a test prompt on its own, e.g. "User can pay with a saved card and see an order confirmation."',
					},
					priority: {
						type: 'string',
						enum: ['must', 'should', 'could', 'unspecified'],
						description:
							'The requirement\'s stated priority (MoSCoW or similar), inferred from the document\'s own language. "unspecified" only when the document genuinely does not indicate priority for this requirement — do not guess one.',
					},
					sourceExcerpt: {
						type: 'string',
						description:
							'The actual text from the document this feature was derived from, verbatim or near-verbatim — not a paraphrase.',
					},
				},
				required: ['feature', 'description', 'priority', 'sourceExcerpt'],
				additionalProperties: false,
			},
		},
	},
	required: ['features'],
	additionalProperties: false,
};

// Single-shot, not agentic — same shape as classifyFileFeatures, except the
// source is a requirements document instead of a code file, and this
// produces the entire feature vocabulary at once rather than tagging one
// already-known file. This is what gives blind mode a real "total" side
// for coverage for the first time — see coverage.ts, which today only ever
// has a structural total (routes/components) in normal mode.
export async function extractBrdFeatures(
	content: string,
	model = 'gpt-5.4-nano',
	client: ResponsesClient = createOpenAIClient(),
	signal?: AbortSignal,
): Promise<ExtractBrdFeaturesResult> {
	const response = await client.responses.create(
		{
			model,
			instructions:
				'You are extracting a structured list of testable features from a business requirements document, for a QA test-generation tool. Read the whole document and identify every distinct feature/requirement a user could meaningfully test — not implementation details, not non-functional requirements (performance, security) unless the document frames them as directly user-testable behavior. Use short, lowercase, dot-separated feature names, matching the convention "checkout" / "checkout.payment" — a broad feature and, where the document genuinely distinguishes it, a more specific sub-feature. Each feature needs a real, specific description substantive enough to become a test prompt on its own, not a restatement of its name. Infer priority from the document\'s own language (must/should/could, MoSCoW, "critical", "nice to have", etc.) — use "unspecified" honestly when the document does not indicate priority for that requirement, rather than guessing. Always include the actual source text (sourceExcerpt) a feature was derived from, so a human can verify the extraction against the real document.',
			input: content.slice(0, 60_000),
			text: {
				format: {
					type: 'json_schema',
					name: 'brd_features',
					schema: EXTRACTION_SCHEMA,
					strict: true,
				},
			},
		},
		signal ? {signal} : undefined,
	);

	if (response.usage) {
		recordUsage(model, response.usage.input_tokens, response.usage.output_tokens);
	}

	try {
		const parsed = JSON.parse(response.output_text) as ExtractBrdFeaturesResult;
		return {
			features: Array.isArray(parsed.features) ? parsed.features : [],
		};
	} catch {
		return {features: []};
	}
}
