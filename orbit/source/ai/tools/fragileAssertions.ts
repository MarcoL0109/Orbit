// Prose guidance alone (agent.ts's data-ownership paragraph) already told the
// model not to assert an exact count/total against shared, growing data —
// and it still wrote exactly that (a pager total like "101-148 / 148" for a
// real, heavily-reused customer). Same lesson as verifiedSelectors.ts's
// findUnverifiedNames: a rule the model must remember to apply on its own
// gets skipped under real generation pressure. This makes the specific,
// previously-observed shape of that mistake mechanically unwritable instead
// of merely discouraged.

// Matches the Odoo-style pager text this bug actually produced, e.g.
// "101-148 / 148" or "1-100 / 148" — two counts separated by a dash, then a
// slash-total. Any test asserting this exact shape as a literal string is
// asserting a real backend total, which only a test that owns the entire
// dataset could ever safely pin down.
const PAGER_TOTAL_PATTERN = /\d+\s*-\s*\d+\s*\/\s*\d+/;

// A test that creates its own data for this run almost never ends up
// asserting a double-digit-or-larger count — write_test_file tests create a
// small, fixed number of records (a quotation, a couple of order lines).
// toHaveCount(10) or higher is far more likely to be a real, shared backend
// total the test happened to observe once.
const LARGE_COUNT_PATTERN = /toHaveCount\(\s*(\d+)\s*\)/g;
const LARGE_COUNT_THRESHOLD = 10;

export function findFragileCountAssertions(content: string): string[] {
	const findings: string[] = [];

	const pagerMatch = content.match(PAGER_TOTAL_PATTERN);
	if (pagerMatch) {
		findings.push(
			`a hardcoded pager/total pattern ("${pagerMatch[0]}") — this reads as a real backend total for shared data, which drifts on every run any test (this one or another) adds to that same data`,
		);
	}

	for (const match of content.matchAll(LARGE_COUNT_PATTERN)) {
		const count = Number(match[1]);
		if (count >= LARGE_COUNT_THRESHOLD) {
			findings.push(
				`toHaveCount(${count}) — a count this large is far more likely to be a real, shared backend total than something this test created itself this run`,
			);
		}
	}

	return findings;
}
