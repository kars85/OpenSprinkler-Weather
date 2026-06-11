// Vitest setupFile (wired via vitest.config.ts `setupFiles`). Runs before any spec imports
// routes/weather.ts, which eagerly instantiates every WeatherProvider at load time and captures
// API keys from process.env in their constructors — so these env vars MUST be set here, not in
// top-of-spec statements (which would run after the hoisted `import './weather'`).
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

// Pin the process timezone so MockDate-based sunrise/sunset assertions are deterministic across
// machines (MockDate.set parses as LOCAL midnight; without this the solar calc shifts ~1 min).
process.env.TZ = "UTC";

process.env.WEATHER_PROVIDER = process.env.WEATHER_PROVIDER || "OWM";
process.env.OWM_API_KEY = process.env.OWM_API_KEY || "NO_KEY";

// Water-budget state during tests goes to a throwaway file, never the real one.
process.env.BUDGET_STATE_FILE = process.env.BUDGET_STATE_FILE
	|| path.join( os.tmpdir(), "wb-test-state.json" );
try { fs.unlinkSync( process.env.BUDGET_STATE_FILE ); } catch ( e ) { /* fine if absent */ }
