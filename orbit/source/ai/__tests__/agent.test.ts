import test from 'ava';
import {agentRunResultToJson, type AgentRunResult} from '../agent.js';
import type {AgentStep} from '../agentLoop.js';
import type {RunTestResult} from '../tools/runTest.js';

function runTestSteps(filePath: string, result: RunTestResult): AgentStep[] {
	return [
		{type: 'tool_call', name: 'run_test', args: {filePath}},
		{type: 'tool_result', name: 'run_test', result: {ok: true, data: result}},
	];
}

function fakeRunTestResult(
	overrides: Partial<RunTestResult> = {},
): RunTestResult {
	return {
		passed: true,
		totalTests: 1,
		passedCount: 1,
		failedCount: 0,
		tests: [{title: 'signs in', status: 'passed', durationMs: 500}],
		failures: [],
		durationMs: 500,
		reportPath: '/fake/report.json',
		...overrides,
	};
}

test('correlates a feature to its run_test result by file path', t => {
	const result: AgentRunResult = {
		status: 'passed',
		summary: 'all good',
		results: [
			{
				feature: 'auth.login',
				file: 'login.spec.ts',
				status: 'passed',
				summary: 'signs in fine',
				requiresManualInput: false,
				manualStepOutcome: null,
				confidence: 'certain',
				rootCause: null,
				explorationResult: 'passed',
				explorationReason: 'verified live',
				backendResult: 'confirmed-success',
				backendReason: 'checked the real response',
				playwrightStage: 'passed',
			},
		],
		steps: runTestSteps('login.spec.ts', fakeRunTestResult()),
	};

	const json = agentRunResultToJson(result);

	t.is(json.status, 'passed');
	t.is(json.features.length, 1);
	t.deepEqual(json.features[0]!.tests, {
		totalTests: 1,
		passedCount: 1,
		failedCount: 0,
		durationMs: 500,
		attempts: 1,
		tests: [{title: 'signs in', status: 'passed', durationMs: 500}],
		failures: [],
	});
});

test('a manual-input feature with no test file gets tests: null', t => {
	const result: AgentRunResult = {
		status: 'passed',
		summary: 'all good',
		results: [
			{
				feature: 'auth.emailVerification',
				file: null,
				status: 'passed',
				summary: 'verified live',
				requiresManualInput: true,
				manualStepOutcome: 'succeeded',
				confidence: 'certain',
				rootCause: null,
				explorationResult: 'passed',
				explorationReason: 'verified live',
				backendResult: 'confirmed-success',
				backendReason: 'checked the real response',
				playwrightStage: 'passed',
			},
		],
		steps: [],
	};

	const json = agentRunResultToJson(result);

	t.is(json.features[0]!.tests, null);
	t.is(json.features[0]!.requiresManualInput, true);
	t.is(json.features[0]!.manualStepOutcome, 'succeeded');
});

test('a repair retry on the same file is reflected as attempts > 1', t => {
	const first = runTestSteps(
		'checkout.spec.ts',
		fakeRunTestResult({passed: false, passedCount: 0, failedCount: 1}),
	);
	const second = runTestSteps('checkout.spec.ts', fakeRunTestResult());

	const result: AgentRunResult = {
		status: 'passed',
		summary: 'all good',
		results: [
			{
				feature: 'checkout.pay',
				file: 'checkout.spec.ts',
				status: 'passed',
				summary: 'repaired and passing',
				requiresManualInput: false,
				manualStepOutcome: null,
				confidence: 'certain',
				rootCause: null,
				explorationResult: 'passed',
				explorationReason: 'verified live',
				backendResult: 'confirmed-success',
				backendReason: 'checked the real response',
				playwrightStage: 'passed',
			},
		],
		steps: [...first, ...second],
	};

	const json = agentRunResultToJson(result);

	t.is(json.features[0]!.tests?.attempts, 2);
	t.is(json.features[0]!.tests?.passedCount, 1);
});
