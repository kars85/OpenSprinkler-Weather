// Mocha setup hook (wired via .mocharc.json `require`). This MUST run before any spec
// file imports routes/weather.ts, because that module eagerly instantiates every
// WeatherProvider (WEATHER_PROVIDERS) at load time and each provider captures its API key
// from process.env in its constructor. Setting these here — rather than as top-of-spec
// statements — avoids the ES-module import-hoisting trap where `import './weather'` runs
// before in-file `process.env.X = ...` assignments.
process.env.WEATHER_PROVIDER = process.env.WEATHER_PROVIDER || "OWM";
process.env.OWM_API_KEY = process.env.OWM_API_KEY || "NO_KEY";
