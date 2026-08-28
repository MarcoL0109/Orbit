// Centralized so the CLI's colors are picked once and reused, not
// re-typed as ad-hoc string literals ('green', 'yellow', ...) at every
// call site — that's what let the same semantic color drift into
// inconsistent literal spellings across app.tsx before this existed.
export const theme = {
	accent: '#a690ff',
	user: '#52e3d9',
	success: '#7be2a8',
	warning: '#f0c674',
	danger: '#ff7f6b',
} as const;
