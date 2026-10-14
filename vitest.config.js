module.exports = {
	test: {
		// Jest-compatible globals (test, expect, describe, beforeAll, ...) so existing
		// and course-provided test files keep working without imports.
		globals: true,
		coverage: {
			// Native V8 coverage. Do not use `--bun`: Bun's V8 coverage API returns
			// incorrect numbers (and the istanbul provider reports "Unknown").
			provider: "v8",
			// Same reporters as jest.config.json, so coverage/coverage-summary.json
			// keeps the shape the CI badge step reads via `jq .total.lines.pct`.
			reporter: ["json-summary", "text"],
			// Same thresholds as jest.config.json. `statements: -10` (disabled in
			// Jest) has no equivalent here, so it is simply omitted.
			thresholds: {
				branches: 30,
				functions: 70,
				lines: 80,
			},
		},
	},
};
