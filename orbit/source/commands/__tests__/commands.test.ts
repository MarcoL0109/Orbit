import test from 'ava';
import {resolveEnvironmentSetupRoot} from '../commands.js';

test('falls back to projectRoot when environmentSetupRoot is not set', t => {
	t.is(
		resolveEnvironmentSetupRoot({environmentSetupRoot: null}, '/repo/frontend'),
		'/repo/frontend',
	);
});

test('uses environmentSetupRoot when configured, ignoring projectRoot', t => {
	t.is(
		resolveEnvironmentSetupRoot(
			{environmentSetupRoot: '/repo'},
			'/repo/frontend',
		),
		'/repo',
	);
});

test('treats a config predating this field (undefined) the same as null', t => {
	t.is(
		resolveEnvironmentSetupRoot(
			{environmentSetupRoot: undefined as unknown as null},
			'/repo/frontend',
		),
		'/repo/frontend',
	);
});
