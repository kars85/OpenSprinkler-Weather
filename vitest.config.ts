import { defineConfig } from "vitest/config";

// Replaces mocha + ts-node + .mocharc (which couldn't boot on Node >=22). Specs are unchanged: they
// use chai `expect`, nock, and mockdate; vitest supplies describe/it/beforeEach/afterEach via
// `globals: true`, and transforms TS natively (no ts-node). The esModuleInterop modernization +
// provider static-import registry made the source graph vite-analyzable.
export default defineConfig( {
	test: {
		include: [ "{routes,test,mqtt,public}/**/*.spec.ts" ],   // same set the old .mocharc glob matched
		environment: "node",
		globals: true,
		setupFiles: [ "./test/setup-env.ts" ],
		// Run spec files serially (as mocha did): suites share process-wide state (a single
		// BUDGET_STATE_FILE, module-level provider singletons) that parallel workers would race on.
		fileParallelism: false,
	},
} );
