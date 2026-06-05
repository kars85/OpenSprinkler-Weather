// Pin the process timezone so MockDate-based sunrise/sunset assertions are deterministic
// across machines. Without this, `MockDate.set('5/13/2019')` parses as LOCAL midnight, so the
// solar calculation shifts ~1 minute depending on the runner's timezone (e.g. a dev box in
// US time vs a UTC CI runner), making the expected sunrise/sunset fixtures environment-specific.
process.env.TZ = "UTC";

// Mocha setup hook (wired via .mocharc.json `require`). This MUST run before any spec
// file imports routes/weather.ts, because that module eagerly instantiates every
// WeatherProvider (WEATHER_PROVIDERS) at load time and each provider captures its API key
// from process.env in its constructor. Setting these here — rather than as top-of-spec
// statements — avoids the ES-module import-hoisting trap where `import './weather'` runs
// before in-file `process.env.X = ...` assignments.
process.env.WEATHER_PROVIDER = process.env.WEATHER_PROVIDER || "OWM";
process.env.OWM_API_KEY = process.env.OWM_API_KEY || "NO_KEY";

// Water-budget state during tests goes to a throwaway file, never the real one.
process.env.BUDGET_STATE_FILE = process.env.BUDGET_STATE_FILE
	|| require( "path" ).join( require( "os" ).tmpdir(), "wb-test-state.json" );
try { require( "fs" ).unlinkSync( process.env.BUDGET_STATE_FILE ); } catch ( e ) { /* fine if absent */ }
