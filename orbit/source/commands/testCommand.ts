import {isReachable, waitUntilReachable} from '../projects/reachability.js';
import {readOrbitConfig, type OrbitConfig} from '../init/config.js';
import {
	readEnvironmentSetupInstructions,
	writeEnvironmentSetupInstructions,
	invalidateEnvironmentSetupInstructions,
} from '../init/memory.js';
import {
	runTestingAgent,
	formatAgentRunResult,
	describeAgentActivity,
	describeAgentStepOutcome,
	type AgentRunResult,
} from '../ai/agent.js';
import {runEnvironmentSetupAgent} from '../ai/environmentSetupAgent.js';
import {writeAgentSession, writeManualInputTestRecords} from '../ai/session.js';
import {writeProjectMap} from '../projects/scan.js';
import {
	scanProjectWithModeSelection,
	graphifyOutcomeMessage,
} from '../projects/scanOrchestration.js';
import {
	refreshBrdFeaturesIfNeeded,
	sortByPriority,
	getFeatureCoverage,
} from '../projects/brdFeatures.js';
import type {BrdFeature} from '../ai/extractBrdFeatures.js';
import type {CommandContext} from './context.js';
import {reportError} from './error.js';

// The setup agent's own projectRoot: environmentSetupRoot when the project
// is a subdirectory of a larger repo and that's been configured, otherwise
// the project's real root — a project where they're the same (the common
// case) needs nothing set. Pulled out as its own function so this choice
// has a name and is testable on its own, rather than sitting as an inline
// ?? at the one call site.
export function resolveEnvironmentSetupRoot(
	orbitConfig: Pick<OrbitConfig, 'environmentSetupRoot'>,
	projectRoot: string,
): string {
	return orbitConfig.environmentSetupRoot ?? projectRoot;
}

// Shared by both environment-setup failure branches below: a saved recipe
// that just failed to bring the app up is more likely wrong than the
// project itself being broken, so it's cleared rather than left to repeat
// the same failure on every future run.
function invalidateStaleSetupInstructions(
	projectRoot: string,
	setMessages: CommandContext['setMessages'],
	hadDocumentedInstructions: boolean,
	reason: string,
): void {
	if (!hadDocumentedInstructions) return;
	invalidateEnvironmentSetupInstructions(projectRoot);
	setMessages(previous => [
		...previous,
		{role: 'agent', content: reason, color: 'gray'},
	]);
}

export type TestCommandOutcome =
	| {ranTest: true; status: AgentRunResult['status']; summary: string}
	| {ranTest: false; reason: string};

// /test's real logic, extracted so it's callable both from the actual /test
// command and from the ask agent's run_test tool. Takes `signal` as a plain
// parameter rather than calling context.startAbortableTask() itself — that
// call creates/owns the shared currentAbortControllerRef in app.tsx, and a
// nested call from inside an already-running ask flow (which already holds
// that ref for the whole ask) would silently steal and then clear it out
// from under the outer flow the moment this function's own cleanup ran.
// Owning that lifecycle is the caller's job: the real /test handler wraps
// this in its own startAbortableTask/clearAbortableTask, and run_test's
// tool wrapper reuses the ask flow's own signal instead of creating one.
export async function runTestCommand(
	prompt: string,
	context: CommandContext,
	signal: AbortSignal,
): Promise<TestCommandOutcome> {
	if (!context.project?.root) {
		reportError(context.setMessages, {kind: 'no-project-selected'});
		return {ranTest: false, reason: 'No project selected'};
	}

	const orbitConfig = context.project.hasOrbitFolder
		? readOrbitConfig(context.project.root)
		: null;

	if (!orbitConfig) {
		reportError(context.setMessages, {kind: 'project-not-initialized'});
		return {
			ranTest: false,
			reason: 'Project is not initialized (run /init first)',
		};
	}

	try {
		// Set only when Orbit itself starts Docker infrastructure this run
		// (not when the environment was already reachable, and not on later
		// /test calls in the same session that just reuse it) — used below
		// to show a one-time reminder that Orbit deliberately never tears
		// containers down itself. See the incident this followed: a manual
		// `docker compose down` outside any Orbit code path removed a
		// container that predated the session entirely.
		let startedDockerInfraThisRun = false;

		// Runs at most once per project per session — see
		// CommandContext.isEnvironmentReady's own note on why a crash
		// mid-session isn't auto-recovered from.
		if (!context.isEnvironmentReady(context.project.root)) {
			const alreadyReachable = await isReachable(orbitConfig.baseUrl);

			if (alreadyReachable) {
				context.markEnvironmentReady(context.project.root);
			} else if (orbitConfig.blind) {
				// Blind mode never tries to discover or start an environment
				// — there is no source here for a setup agent to read or run
				// commands from (projectRoot is Orbit's own empty
				// workspace, not the target app), and doing so anyway would
				// be exactly the kind of unattended shell-command execution
				// blind mode exists to avoid. Fail fast and clearly instead.
				reportError(context.setMessages, {
					kind: 'blind-target-unreachable',
					baseUrl: orbitConfig.baseUrl,
				});
				return {
					ranTest: false,
					reason: `${orbitConfig.baseUrl} is not reachable`,
				};
			} else {
				// Give the user a chance to hand-write the startup sequence
				// before defaulting to AI discovery — they usually already
				// know it (they built the project), and typing it out is
				// far faster than the agent rediscovering it live through
				// trial and error. requestInput here is just a "press
				// Enter when you're done editing the file" gate, not a
				// text collector — a multi-line shell recipe doesn't
				// belong typed into the single-line TextInput it renders
				// (see app.tsx), so the actual editing happens in the
				// user's own editor against the file directly.
				if (readEnvironmentSetupInstructions(context.project.root) === null) {
					await context.requestInput(
						`No dev environment startup instructions found. Add them to .orbit/memory/environment_setup.md now, then press Enter to continue — or just press Enter to let Orbit figure it out itself instead (slower, first run only).`,
					);
				}

				context.setAgentActivity('Setting up the dev environment...');

				// Captured after the pause above, not before — this
				// reflects whatever the user actually did (wrote their own
				// file, or skipped) rather than stale pre-prompt state,
				// and is what decides whether a returned setupProcedure
				// gets persisted below. A file the user just hand-wrote is
				// never overwritten by the agent's own reconstruction of
				// it.
				const hadDocumentedInstructions =
					readEnvironmentSetupInstructions(context.project.root) !== null;

				const setupResult = await runEnvironmentSetupAgent(
					{
						// Widened only for the setup agent itself — a
						// project whose root is a subdirectory of a larger
						// repo (the JS app alongside a sibling
						// backend/docker-compose.yml/README) leaves
						// read_file and run_command's cwd sandboxed to
						// projectRoot otherwise, with no way to discover
						// anything one level up. Every other call below
						// (scan, the testing agent) keeps using
						// context.project.root unchanged.
						projectRoot: resolveEnvironmentSetupRoot(
							orbitConfig,
							context.project.root,
						),
						orbitConfig,
						signal,
						requestApproval: context.requestApproval,
					},
					{
						onProgress(event) {
							context.setAgentActivity(describeAgentActivity(event));
						},
					},
				);

				if (setupResult.status === 'aborted') {
					context.setMessages(previous => [
						...previous,
						{
							role: 'agent',
							content: `Aborted: ${setupResult.notes}`,
							color: 'yellow',
						},
					]);
					return {ranTest: false, reason: 'Aborted during environment setup'};
				}

				if (setupResult.status === 'gave_up') {
					// The agent got stuck trying to follow a recipe it was
					// told to trust — that recipe is probably why it's
					// stuck, so clear it rather than handing the next run
					// the same dead end.
					invalidateStaleSetupInstructions(
						context.project.root,
						context.setMessages,
						hadDocumentedInstructions,
						'The saved setup steps in .orbit/memory/environment_setup.md failed, so they were cleared — the next run will rediscover them from scratch.',
					);

					reportError(context.setMessages, {
						kind: 'environment-setup-gave-up',
						notes: setupResult.notes,
					});
					return {
						ranTest: false,
						reason: `Environment setup gave up: ${setupResult.notes}`,
					};
				}

				// Status === 'signaled' — its own belief is never trusted
				// as proof; verify independently. Retried over a short
				// window, not a single check: a service that was just
				// told to start can take a few seconds to actually bind
				// its port after the start command itself has already
				// returned.
				context.setAgentActivity('Confirming the environment is reachable...');
				const nowReachable = await waitUntilReachable(orbitConfig.baseUrl);
				if (!nowReachable) {
					// The agent followed the documented recipe and
					// believed it worked, but the app never actually came
					// up — the recipe itself is the likely culprit, so
					// clear it rather than repeating the same failure on
					// every future run.
					invalidateStaleSetupInstructions(
						context.project.root,
						context.setMessages,
						hadDocumentedInstructions,
						'The saved setup steps in .orbit/memory/environment_setup.md ran but the app never became reachable, so they were cleared — the next run will rediscover them from scratch.',
					);

					reportError(context.setMessages, {
						kind: 'environment-not-reachable',
						baseUrl: orbitConfig.baseUrl,
						notes: setupResult.notes,
					});
					return {
						ranTest: false,
						reason: `${orbitConfig.baseUrl} is not reachable`,
					};
				}

				// Only ever writes a file the agent had to discover from
				// scratch — never overwrites one that was already there
				// to follow, and never writes on a self-report that
				// reachability then contradicted.
				if (!hadDocumentedInstructions && setupResult.setupProcedure) {
					writeEnvironmentSetupInstructions(
						context.project.root,
						setupResult.setupProcedure,
					);
					context.setMessages(previous => [
						...previous,
						{
							role: 'agent',
							content:
								'Saved the setup steps it discovered to .orbit/memory/environment_setup.md for next time.',
							color: 'gray',
						},
					]);
				}

				context.markEnvironmentReady(context.project.root);
				startedDockerInfraThisRun = orbitConfig.dockerComposeFile !== null;
			}
		}

		// Keep the project index fresh before every run — cheap in
		// practice since scanProject skips unchanged files by mtime/size,
		// and non-fatal if it fails: the agent still works from whatever
		// map (if any) was already on disk. Skipped entirely for a blind
		// project: there is no local source to scan, and running it would
		// at best index Orbit's own generated files, at worst prompt the
		// user for a scan mode (regex/graphify) that has no meaning here.
		if (!orbitConfig.blind) {
			try {
				context.setAgentActivity('Scanning project for changes...');
				const {projectMap, graphifyOutcome} =
					await scanProjectWithModeSelection(context.project.root, {
						requestApproval: context.requestApproval,
						requestScanMode: context.requestScanMode,
						setMessages: context.setMessages,
					});
				writeProjectMap(context.project.root, projectMap);

				const graphifyMessage = graphifyOutcomeMessage(graphifyOutcome);
				if (graphifyMessage) {
					context.setMessages(previous => [
						...previous,
						{role: 'agent', ...graphifyMessage},
					]);
				}
			} catch (error) {
				reportError(context.setMessages, {
					kind: 'unexpected',
					action: 'Pre-test project scan',
					cause: error,
				});
			}
		}

		// Kept alongside the project scan, same reasoning: cheap when nothing
		// changed (checksum-gated), non-fatal if it fails, and keeps
		// brd-features.json current for the NEXT /test call whether or not
		// this particular run is the one using it. A no-op when brdPath
		// isn't configured.
		if (orbitConfig.brdPath) {
			try {
				const refreshResult = await refreshBrdFeaturesIfNeeded(
					context.project.root,
					orbitConfig.brdPath,
					orbitConfig.classificationModel,
				);
				if (!refreshResult.ok) {
					context.setMessages(previous => [
						...previous,
						{
							role: 'agent',
							content: `BRD refresh skipped: ${refreshResult.error}`,
							color: 'yellow',
						},
					]);
				} else if (refreshResult.refreshed) {
					context.setMessages(previous => [
						...previous,
						{
							role: 'agent',
							content: `BRD re-scanned: ${refreshResult.data.features.length} feature(s) extracted from ${orbitConfig.brdPath}.`,
							color: 'gray',
						},
					]);
				}
			} catch (error) {
				context.setMessages(previous => [
					...previous,
					{
						role: 'agent',
						content: `BRD refresh failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
						color: 'yellow',
					},
				]);
			}
		}

		context.setAgentActivity('Analyzing the request...');

		const result = await runTestingAgent(
			prompt,
			{
				projectRoot: context.project.root,
				orbitConfig,
				signal,
				requestApproval: context.requestApproval,
				requestInput: context.requestInput,
				requestOutcomeConfirmation: context.requestOutcomeConfirmation,
			},
			{
				onProgress(event) {
					const activity = describeAgentActivity(event);
					context.setAgentActivity(activity);
					context.setMessages(previous => [
						...previous,
						{
							role: 'agent',
							content: `→ ${activity}`,
							color: 'gray',
							dim: true,
						},
					]);
				},
				onStepResult(name, args, stepResult) {
					context.setMessages(previous => [
						...previous,
						{
							role: 'agent',
							content: describeAgentStepOutcome(name, args, stepResult),
							color: stepResult.ok ? 'green' : 'red',
						},
					]);
				},
			},
		);

		writeAgentSession(context.project.root, prompt, result);
		const manualInputRecords = writeManualInputTestRecords(
			context.project.root,
			orbitConfig,
			result.results,
		);
		if (manualInputRecords.error) {
			const manualInputError = manualInputRecords.error;
			context.setMessages(previous => [
				...previous,
				{
					role: 'agent',
					content: `Could not save manual-input test records: ${manualInputError}`,
					color: 'red',
				},
			]);
		}

		const summary = formatAgentRunResult(result);

		context.setMessages(previous => [
			...previous,
			{
				role: 'agent',
				content: summary,
				color:
					result.status === 'passed'
						? 'green'
						: result.status === 'aborted'
						? 'yellow'
						: 'red',
			},
		]);

		// One-time per session, not on every /test — see
		// isEnvironmentReady's own caching, which is exactly why this
		// only needs to fire once even across many /test runs against
		// the same project. Orbit never runs this itself; it's left
		// entirely to the user.
		if (startedDockerInfraThisRun) {
			context.setMessages(previous => [
				...previous,
				{
					role: 'agent',
					content:
						"Docker containers are still running for this project. Orbit leaves them up for reuse across /test runs and never stops them on its own — run `docker compose down` yourself when you're done with them.",
					color: 'gray',
				},
			]);
		}

		return {ranTest: true, status: result.status, summary};
	} catch (error) {
		reportError(context.setMessages, {
			kind: 'unexpected',
			action: 'Test agent run',
			cause: error,
		});
		return {
			ranTest: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export type TestEverythingOutcome =
	| {ran: true; featureCount: number}
	| {ran: false; reason: string};

const PRIORITY_SECTION_ORDER: BrdFeature['priority'][] = [
	'must',
	'should',
	'could',
	'unspecified',
];

// Numbered to match run order exactly (so "run 4 failed" is unambiguous
// later), grouped under a priority heading so the shape of the batch is
// visible at a glance — feature name and description on separate lines so
// a long description never runs into the name, and a coverage note on its
// own line when a past run already covered it (see getFeatureCoverage: this
// is informational only, never a reason to skip — the app may have changed
// since). `features` must already be sortByPriority'd; this only groups, it
// doesn't re-sort.
function formatFeatureList(
	features: BrdFeature[],
	coverage: Map<string, string[]>,
): string {
	let index = 0;
	const sections = PRIORITY_SECTION_ORDER.map(priority => {
		const inSection = features.filter(f => f.priority === priority);
		if (inSection.length === 0) return null;

		const lines = inSection.map(feature => {
			index += 1;
			const coveredBy = coverage.get(feature.feature);
			const coverageNote = coveredBy
				? `\n     (previously covered by ${coveredBy.join(', ')} — re-testing in case the feature changed)`
				: '';
			return `  ${index}. ${feature.feature}\n     ${feature.description}${coverageNote}`;
		});

		return `${priority.toUpperCase()}\n${lines.join('\n')}`;
	}).filter((section): section is string => section !== null);

	return sections.join('\n\n');
}

// /test with no prompt: autonomously test every BRD feature, in priority
// order, instead of the user describing one feature at a time. Each feature
// just becomes runTestCommand's own prompt — this doesn't duplicate that
// logic, it drives it in a loop. Every feature runs every time, even ones a
// past run already covered — Orbit has no way to know whether the
// underlying app changed since (no git access, and in blind mode no source
// access at all), so treating past coverage as a reason to skip would just
// be guessing that nothing changed. Past coverage is still shown, via
// formatFeatureList, so this isn't opaque about which are re-tests. See the
// design conversation this followed: the list is always shown and approved
// as one batch before anything runs, since each feature test has the same
// real, permanent side effects (a real record created, a real test file
// written) as any other /test run, just multiplied across the whole BRD.
export async function runTestEverythingFromBrd(
	context: CommandContext,
	signal: AbortSignal,
): Promise<TestEverythingOutcome> {
	if (!context.project?.root) {
		reportError(context.setMessages, {kind: 'no-project-selected'});
		return {ran: false, reason: 'No project selected'};
	}

	const orbitConfig = context.project.hasOrbitFolder
		? readOrbitConfig(context.project.root)
		: null;

	if (!orbitConfig) {
		reportError(context.setMessages, {kind: 'project-not-initialized'});
		return {
			ran: false,
			reason: 'Project is not initialized (run /init first)',
		};
	}

	if (!orbitConfig.brdPath) {
		reportError(context.setMessages, {
			kind: 'invalid-arg-count',
			usage: '/test <prompt>',
			expected: 'at least 1 (or none, once a BRD is configured via /config)',
			given: 0,
		});
		return {ran: false, reason: 'No BRD configured and no prompt given'};
	}

	context.setAgentActivity('Checking the BRD for changes...');
	const refreshResult = await refreshBrdFeaturesIfNeeded(
		context.project.root,
		orbitConfig.brdPath,
		orbitConfig.classificationModel,
		undefined,
		signal,
	);

	if (!refreshResult.ok) {
		reportError(context.setMessages, {
			kind: 'unexpected',
			action: 'BRD extraction',
			cause: new Error(refreshResult.error),
		});
		return {ran: false, reason: refreshResult.error};
	}

	const brdFeatures = refreshResult.data;
	const features = sortByPriority(brdFeatures.features);
	const coverage = getFeatureCoverage(context.project.root, orbitConfig.testDir);
	const recoveredCount = features.filter(f => coverage.has(f.feature)).length;

	context.setMessages(previous => [
		...previous,
		{
			role: 'agent',
			content: `${features.length} feature(s) from the BRD, in the order they'll run${
				recoveredCount > 0
					? ` (${recoveredCount} previously covered, re-testing anyway)`
					: ''
			}:\n\n${formatFeatureList(features, coverage)}`,
		},
	]);

	const approved = await context.requestApproval(
		`Run ${features.length} test(s) for the features above? Each writes a real test file and runs it against the live app.`,
	);
	if (!approved) {
		return {ran: false, reason: 'User declined to run the batch'};
	}

	for (const feature of features) {
		if (signal.aborted) break;
		await runTestCommand(feature.description, context, signal);
	}

	return {ran: true, featureCount: features.length};
}
