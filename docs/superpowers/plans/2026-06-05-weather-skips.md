# Weather Skips (Freeze / Wind / Rain) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three opt-in, cross-cutting "skip" guards (freeze / wind / rain) that force `scale = 0` when their condition is met, applied as a live per-request overlay on top of any adjustment method, without changing the existing cache or California restriction behavior.

**Architecture:** A pure `evaluateSkips()` (+ config/parsing) in `routes/skips/WeatherSkips.ts`; an I/O layer in `routes/skips/SkipGuard.ts` (a short-TTL skip-weather memo + an `applyWeatherSkips()` overlay that fetches weather fail-open, evaluates, and returns a *fresh* response object). `getWateringData` calls `applyWeatherSkips()` once, after cache/restriction resolution and before legacy conversion; `convertToLegacyFormat` gets a universal `skip`/`skipReason` passthrough.

**Tech Stack:** TypeScript (es5/commonjs), Express, mocha + chai + nock (existing test stack). `.mocharc.json` wires `ts-node/register` + `test/setup-env.ts` + `TZ=UTC`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `routes/skips/WeatherSkips.ts` | Pure: types, `parseBool`, `evaluateSkips`, `resolveSkipConfig`, `anySkipEnabled`. No I/O. | Create |
| `routes/skips/SkipGuard.ts` | I/O: skip-weather memo (`skipMemoKey`, `fetchSkipWeather`, `__clearSkipWeatherMemo`) + `applyWeatherSkips` overlay. | Create |
| `routes/weather.ts` | Call `applyWeatherSkips` after cache/restriction resolution; add universal `skip`/`skipReason` passthrough to `convertToLegacyFormat`. | Modify |
| `routes/skips/WeatherSkips.spec.ts` | Pure unit tests. | Create |
| `routes/skips/SkipGuard.spec.ts` | Memo + overlay tests (with a stub provider). | Create |
| `routes/weather.spec.ts` | One full-stack route test (freeze skip → scale 0 + legacy `skipReason`). | Modify |
| `docs/weather-skips.md` | User guide. | Create |

**Test commands:** subset → `npm test -- --grep "<name>"`; full → `npm test`; type-check → `npm run compile`.

> **Empirica note (this session only):** the sentinel firewall gates praxic commands. If a `git`/`npm`/Edit call is denied with `Epistemic loop closed` / `Run new PREFLIGHT`, open a transaction with three **bare-leading** commands before retrying: `empirica session-create --ai-id claude-code --project-id OpenSprinkler-Weather --output json` (grab the `session_id`), then `empirica preflight-submit -` and `empirica check-submit -` (JSON on stdin with `vectors` + `decision:"ready"`). Close later with `empirica postflight-submit -`. A normal worker/branch without the sentinel can ignore this.

---

## Task 1: Pure `WeatherSkips` (types, parsing, evaluator, config)

**Files:**
- Create: `routes/skips/WeatherSkips.ts`
- Test: `routes/skips/WeatherSkips.spec.ts`

- [ ] **Step 1: Write the failing tests.** Create `routes/skips/WeatherSkips.spec.ts`:

```typescript
import { expect } from "chai";
import { anySkipEnabled, evaluateSkips, parseBool, resolveSkipConfig, SkipConfig } from "./WeatherSkips";

describe( "WeatherSkips.parseBool", () => {
	it( "enables only on true/1/yes/on (case-insensitive)", () => {
		for ( const t of [ "true", "TRUE", "1", "yes", "On" ] ) expect( parseBool( t ) ).to.equal( true );
		for ( const f of [ undefined, "", "false", "0", "no", "off", "enabled", "x" ] ) expect( parseBool( f as any ) ).to.equal( false );
	} );
} );

describe( "WeatherSkips.evaluateSkips", () => {
	it( "no enabled rules => no skip", () => {
		expect( evaluateSkips( { minTemp: -50, wind: 99, precip: 9 }, {} ) ).to.deep.equal( { skip: false } );
	} );

	it( "freeze fires inclusively and reports ASCII reason (no = < > quotes)", () => {
		const r = evaluateSkips( { minTemp: 32 }, { freeze: { temp: 32 } } );
		expect( r.skip ).to.equal( true );
		expect( r.reason ).to.equal( "freeze: 32F at or below 32F" );
		expect( /[=<>"]/.test( r.reason! ) ).to.equal( false );
		expect( evaluateSkips( { minTemp: 33 }, { freeze: { temp: 32 } } ).skip ).to.equal( false );
	} );

	it( "freeze falls back to current temp when minTemp is missing (local/PWS)", () => {
		expect( evaluateSkips( { temp: 30 }, { freeze: { temp: 32 } } ).skip ).to.equal( true );
		expect( evaluateSkips( { minTemp: undefined, temp: 30 } as any, { freeze: { temp: 32 } } ).skip ).to.equal( true );
	} );

	it( "wind and rain fire inclusively", () => {
		expect( evaluateSkips( { wind: 25 }, { wind: { max: 25 } } ).reason ).to.equal( "wind: 25mph at or above 25mph" );
		expect( evaluateSkips( { wind: 24 }, { wind: { max: 25 } } ).skip ).to.equal( false );
		expect( evaluateSkips( { precip: 0.1 }, { rain: { threshold: 0.1 } } ).reason ).to.equal( "rain: 0.1in at or above 0.1in" );
		expect( evaluateSkips( { precip: 0.05 }, { rain: { threshold: 0.1 } } ).skip ).to.equal( false );
	} );

	it( "a missing field disables only its own rule; other rules still evaluate", () => {
		// No temp data at all, but wind is high -> wind still fires.
		const cfg: SkipConfig = { freeze: { temp: 32 }, wind: { max: 25 }, rain: { threshold: 0.1 } };
		const r = evaluateSkips( { wind: 30 }, cfg );
		expect( r.skip ).to.equal( true );
		expect( r.reason ).to.contain( "wind" );
	} );

	it( "first trigger wins in freeze > wind > rain order", () => {
		const cfg: SkipConfig = { freeze: { temp: 32 }, wind: { max: 25 }, rain: { threshold: 0.1 } };
		expect( evaluateSkips( { minTemp: 20, wind: 30, precip: 1 }, cfg ).reason ).to.contain( "freeze" );
		expect( evaluateSkips( { minTemp: 50, wind: 30, precip: 1 }, cfg ).reason ).to.contain( "wind" );
		expect( evaluateSkips( { minTemp: 50, wind: 5, precip: 1 }, cfg ).reason ).to.contain( "rain" );
	} );

	it( "non-finite fields never trigger a skip", () => {
		const cfg: SkipConfig = { freeze: { temp: 32 }, wind: { max: 25 }, rain: { threshold: 0.1 } };
		expect( evaluateSkips( { minTemp: NaN, temp: NaN, wind: NaN, precip: NaN }, cfg ).skip ).to.equal( false );
	} );
} );

describe( "WeatherSkips.resolveSkipConfig", () => {
	it( "is empty when nothing is enabled (threshold alone never enables)", () => {
		const cfg = resolveSkipConfig( {}, { FREEZE_TEMP: "40", WIND_MAX: "10", RAIN_SKIP: "0.2" } );
		expect( anySkipEnabled( cfg ) ).to.equal( false );
		expect( cfg ).to.deep.equal( {} );
	} );

	it( "enables rules from env with defaults", () => {
		const cfg = resolveSkipConfig( {}, { SKIP_FREEZE: "on", SKIP_WIND: "1", SKIP_RAIN: "yes" } );
		expect( cfg ).to.deep.equal( { freeze: { temp: 32 }, wind: { max: 25 }, rain: { threshold: 0.1 } } );
	} );

	it( "env thresholds override defaults only for enabled rules", () => {
		const cfg = resolveSkipConfig( {}, { SKIP_FREEZE: "true", FREEZE_TEMP: "37", WIND_MAX: "10" } );
		expect( cfg ).to.deep.equal( { freeze: { temp: 37 } } );
	} );

	it( "wto overrides env (enable + threshold)", () => {
		const cfg = resolveSkipConfig( { skipWind: "on", skipWindMax: 18 }, { SKIP_WIND: "off", WIND_MAX: "25" } );
		expect( cfg ).to.deep.equal( { wind: { max: 18 } } );
	} );
} );
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "WeatherSkips"`
Expected: FAIL — `Cannot find module './WeatherSkips'`.

- [ ] **Step 3: Write the implementation.** Create `routes/skips/WeatherSkips.ts`:

```typescript
export interface SkipWeather {
	minTemp?: number;
	temp?: number;
	wind?: number;
	precip?: number;
}

export interface SkipConfig {
	freeze?: { temp: number };
	wind?: { max: number };
	rain?: { threshold: number };
}

export interface SkipResult {
	skip: boolean;
	reason?: string;
}

/** Strict boolean parse: only true/1/yes/on (case-insensitive) enable. Anything else is false. */
export function parseBool( v: string | undefined ): boolean {
	if ( v === undefined || v === null ) return false;
	return [ "true", "1", "yes", "on" ].indexOf( String( v ).trim().toLowerCase() ) !== -1;
}

function isNum( x: any ): x is number {
	return typeof x === "number" && Number.isFinite( x );
}

function r1( x: number ): number {
	return Math.round( x * 10 ) / 10;
}

/**
 * Evaluate freeze/wind/rain skips. Only enabled rules are present in cfg. Each rule is
 * independently fail-open (no-ops if its field is missing/non-finite). Inclusive boundaries.
 * Safety order: freeze, then wind, then rain. First trigger wins. Reasons are ASCII words only.
 */
export function evaluateSkips( w: SkipWeather, cfg: SkipConfig ): SkipResult {
	if ( cfg.freeze ) {
		const t = isNum( w.minTemp ) ? w.minTemp : ( isNum( w.temp ) ? w.temp : undefined );
		if ( isNum( t ) && t <= cfg.freeze.temp ) {
			return { skip: true, reason: `freeze: ${ r1( t ) }F at or below ${ cfg.freeze.temp }F` };
		}
	}
	if ( cfg.wind && isNum( w.wind ) && w.wind >= cfg.wind.max ) {
		return { skip: true, reason: `wind: ${ r1( w.wind ) }mph at or above ${ cfg.wind.max }mph` };
	}
	if ( cfg.rain && isNum( w.precip ) && w.precip >= cfg.rain.threshold ) {
		return { skip: true, reason: `rain: ${ r1( w.precip ) }in at or above ${ cfg.rain.threshold }in` };
	}
	return { skip: false };
}

export function anySkipEnabled( cfg: SkipConfig ): boolean {
	return !!( cfg.freeze || cfg.wind || cfg.rain );
}

function numOr( raw: any, fallback: number ): number {
	const v = Number( raw );
	return Number.isFinite( v ) ? v : fallback;
}

/**
 * Build a SkipConfig from env defaults overridden by per-request `wto` options.
 * Enabling a rule (SKIP_* / skip*) is strictly separate from its threshold value.
 * `env` is injectable for tests; defaults to process.env.
 */
export function resolveSkipConfig(
	adjustmentOptions: { [ k: string ]: any },
	env: { [ k: string ]: string | undefined } = process.env as any
): SkipConfig {
	const o = adjustmentOptions || {};
	const enabled = ( wtoKey: string, envKey: string ): boolean =>
		o[ wtoKey ] !== undefined ? parseBool( String( o[ wtoKey ] ) ) : parseBool( env[ envKey ] );
	const value = ( wtoKey: string, envKey: string, def: number ): number =>
		o[ wtoKey ] !== undefined ? numOr( o[ wtoKey ], def ) : numOr( env[ envKey ], def );

	const cfg: SkipConfig = {};
	if ( enabled( "skipFreeze", "SKIP_FREEZE" ) ) cfg.freeze = { temp: value( "skipFreezeTemp", "FREEZE_TEMP", 32 ) };
	if ( enabled( "skipWind", "SKIP_WIND" ) ) cfg.wind = { max: value( "skipWindMax", "WIND_MAX", 25 ) };
	if ( enabled( "skipRain", "SKIP_RAIN" ) ) cfg.rain = { threshold: value( "skipRainThreshold", "RAIN_SKIP", 0.1 ) };
	return cfg;
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npm test -- --grep "WeatherSkips"`
Expected: PASS. Also run `npm run compile` (clean).

- [ ] **Step 5: Commit.**

```bash
git add routes/skips/WeatherSkips.ts routes/skips/WeatherSkips.spec.ts
git commit -m "feat(skips): pure evaluateSkips + strict config parsing [#weather-skips]"
```

---

## Task 2: `SkipGuard` — memo + overlay

**Files:**
- Create: `routes/skips/SkipGuard.ts`
- Test: `routes/skips/SkipGuard.spec.ts`

- [ ] **Step 1: Write the failing tests.** Create `routes/skips/SkipGuard.spec.ts`:

```typescript
import { expect } from "chai";
import { GeoCoordinates, PWS, WeatherData, ZimmermanWateringData } from "../../types";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import { EToData } from "../adjustmentMethods/EToAdjustmentMethod";
import { applyWeatherSkips, fetchSkipWeather, skipMemoKey, __clearSkipWeatherMemo } from "./SkipGuard";

// Stub provider whose getWeatherData returns canned data (or throws / counts calls).
class StubProvider extends WeatherProvider {
	public calls = 0;
	constructor( private readonly wd: Partial<WeatherData> | null, private readonly fail = false ) { super(); }
	public async getWateringData(): Promise< ZimmermanWateringData > { throw new Error( "n/a" ); }
	public async getEToData(): Promise< EToData > { throw new Error( "n/a" ); }
	public async getWeatherData(): Promise< WeatherData > {
		this.calls++;
		if ( this.fail ) throw new Error( "boom" );
		return this.wd as WeatherData;
	}
}

const coords: GeoCoordinates = [ 42.3732, -72.5199 ];

describe( "SkipGuard.skipMemoKey", () => {
	it( "isolates by provider, selected provider, coords, and pws", () => {
		const p = new StubProvider( {} );
		const a = skipMemoKey( p, coords, undefined, { provider: "OWM" } as any );
		expect( a ).to.contain( "StubProvider" ).and.contain( "OWM" ).and.contain( "42.3732,-72.5199" ).and.contain( "nopws" );
		expect( skipMemoKey( p, coords, undefined, { provider: "OpenMeteo" } as any ) ).to.not.equal( a );
		expect( skipMemoKey( p, [ 1, 2 ], undefined, { provider: "OWM" } as any ) ).to.not.equal( a );
		expect( skipMemoKey( p, coords, { id: "KMA", apiKey: "x" }, { provider: "OWM" } as any ) ).to.contain( "KMA" );
		expect( skipMemoKey( p, coords, { apiKey: "x" }, { provider: "OWM" } as any ) ).to.contain( "pwskey" );
	} );
} );

describe( "SkipGuard.fetchSkipWeather", () => {
	beforeEach( () => __clearSkipWeatherMemo() );

	it( "memoizes within the TTL and refetches after it expires", async () => {
		process.env.SKIP_WEATHER_TTL = "1000";
		const p = new StubProvider( { minTemp: 30, temp: 35, wind: 5, precip: 0 } );
		await fetchSkipWeather( p, coords, undefined, { provider: "OWM" } as any, 1000 );
		await fetchSkipWeather( p, coords, undefined, { provider: "OWM" } as any, 1500 ); // within TTL
		expect( p.calls ).to.equal( 1 );
		await fetchSkipWeather( p, coords, undefined, { provider: "OWM" } as any, 2500 ); // expired
		expect( p.calls ).to.equal( 2 );
		delete process.env.SKIP_WEATHER_TTL;
	} );

	it( "fails open (undefined) and does not memoize failures", async () => {
		const p = new StubProvider( null, true );
		expect( await fetchSkipWeather( p, coords, undefined, {} as any, 1000 ) ).to.equal( undefined );
		expect( await fetchSkipWeather( p, coords, undefined, {} as any, 1000 ) ).to.equal( undefined );
		expect( p.calls ).to.equal( 2 ); // re-attempted, not cached
	} );
} );

describe( "SkipGuard.applyWeatherSkips", () => {
	beforeEach( () => __clearSkipWeatherMemo() );
	const base = { scale: 80, rawData: { wp: "OWM", t: 70 } };

	it( "returns the input unchanged when no skip is enabled", async () => {
		const p = new StubProvider( { minTemp: 10 } );
		const out = await applyWeatherSkips( base, p, coords, undefined, {} as any, 1000 );
		expect( out ).to.equal( base ); // same reference, no fetch needed
		expect( p.calls ).to.equal( 0 );
	} );

	it( "forces scale 0 + skip metadata on a freeze, in a FRESH object (no mutation)", async () => {
		process.env.SKIP_FREEZE = "on";
		const p = new StubProvider( { minTemp: 28, temp: 30, wind: 4, precip: 0 } );
		const out = await applyWeatherSkips( base, p, coords, undefined, { provider: "OWM" } as any, 1000 );
		expect( out.scale ).to.equal( 0 );
		expect( out.rawData.skip ).to.equal( 1 );
		expect( out.rawData.skipReason ).to.contain( "freeze" );
		// original is untouched
		expect( base.scale ).to.equal( 80 );
		expect( ( base.rawData as any ).skip ).to.equal( undefined );
		expect( out.rawData ).to.not.equal( base.rawData );
		delete process.env.SKIP_FREEZE;
	} );

	it( "does NOT add metadata when enabled but conditions are mild", async () => {
		process.env.SKIP_FREEZE = "on";
		const p = new StubProvider( { minTemp: 50, temp: 55 } );
		const out = await applyWeatherSkips( base, p, coords, undefined, {} as any, 1000 );
		expect( out ).to.equal( base );
		delete process.env.SKIP_FREEZE;
	} );

	it( "leaves a restriction-induced 0 untouched and adds NO metadata when no skip fires", async () => {
		process.env.SKIP_FREEZE = "on";
		const restricted = { scale: 0, rawData: { wp: "OWM" } };
		const p = new StubProvider( { minTemp: 50 } ); // no freeze
		const out = await applyWeatherSkips( restricted, p, coords, undefined, {} as any, 1000 );
		expect( out ).to.equal( restricted );
		expect( ( out.rawData as any ).skip ).to.equal( undefined );
		expect( ( out.rawData as any ).skipReason ).to.equal( undefined );
		delete process.env.SKIP_FREEZE;
	} );

	it( "fails open when getWeatherData throws (no skip, input unchanged)", async () => {
		process.env.SKIP_FREEZE = "on";
		const p = new StubProvider( null, true );
		const out = await applyWeatherSkips( base, p, coords, undefined, {} as any, 1000 );
		expect( out ).to.equal( base );
		delete process.env.SKIP_FREEZE;
	} );
} );
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "SkipGuard"`
Expected: FAIL — `Cannot find module './SkipGuard'`.

- [ ] **Step 3: Write the implementation.** Create `routes/skips/SkipGuard.ts`:

```typescript
import { GeoCoordinates, PWS, WeatherData } from "../../types";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import { AdjustmentOptions } from "../adjustmentMethods/AdjustmentMethod";
import { anySkipEnabled, evaluateSkips, resolveSkipConfig, SkipWeather } from "./WeatherSkips";

interface MemoEntry { weather: SkipWeather; expires: number; }

// Module-level memo, intentionally separate from WateringScaleCache (different TTL/semantics).
const memo: { [ key: string ]: MemoEntry } = {};

function ttlMs(): number {
	const v = Number( process.env.SKIP_WEATHER_TTL );
	return Number.isFinite( v ) && v > 0 ? v : 600000; // default 10 min
}

/** Test helper: clear the memo between cases. */
export function __clearSkipWeatherMemo(): void {
	for ( const k in memo ) delete memo[ k ];
}

/**
 * Memo key guards against cross-poisoning: provider mode (local vs remote), provider class,
 * selected provider, rounded coords, and PWS identity (id, else a generic marker for key-only).
 */
export function skipMemoKey(
	weatherProvider: WeatherProvider, coordinates: GeoCoordinates,
	pws: PWS | undefined, adjustmentOptions: AdjustmentOptions
): string {
	const mode = process.env.WEATHER_PROVIDER === "local" ? "local" : "remote";
	const provider = weatherProvider && weatherProvider.constructor ? weatherProvider.constructor.name : "unknown";
	const selected = ( adjustmentOptions && adjustmentOptions.provider ) || "";
	const coords = `${ coordinates[ 0 ].toFixed( 4 ) },${ coordinates[ 1 ].toFixed( 4 ) }`;
	const pwsKey = pws ? ( pws.id || "pwskey" ) : "nopws";
	return `${ mode }|${ provider }|${ selected }|${ coords }|${ pwsKey }`;
}

/**
 * One fail-open getWeatherData call, memoized with a short TTL. Returns undefined on any failure
 * (and does not memoize the failure). `now` is injectable for deterministic tests.
 */
export async function fetchSkipWeather(
	weatherProvider: WeatherProvider, coordinates: GeoCoordinates, pws: PWS | undefined,
	adjustmentOptions: AdjustmentOptions, now: number = Date.now()
): Promise< SkipWeather | undefined > {
	const key = skipMemoKey( weatherProvider, coordinates, pws, adjustmentOptions );
	const hit = memo[ key ];
	if ( hit && hit.expires > now ) return hit.weather;
	let wd: WeatherData;
	try {
		wd = await weatherProvider.getWeatherData( coordinates, pws );
	} catch ( err ) {
		return undefined; // fail-open; do not memoize failures
	}
	if ( !wd ) return undefined;
	const weather: SkipWeather = { minTemp: wd.minTemp, temp: wd.temp, wind: wd.wind, precip: wd.precip };
	memo[ key ] = { weather, expires: now + ttlMs() };
	return weather;
}

/**
 * Live skip overlay. Returns the input unchanged unless a skip actually fires, in which case it
 * returns a FRESH object with scale = 0 and rawData.skip / rawData.skipReason. Never mutates the
 * (possibly cached) input. Fail-open at every step.
 */
export async function applyWeatherSkips(
	dataToSend: any, weatherProvider: WeatherProvider, coordinates: GeoCoordinates,
	pws: PWS | undefined, adjustmentOptions: AdjustmentOptions, now: number = Date.now()
): Promise< any > {
	const cfg = resolveSkipConfig( adjustmentOptions || {} );
	if ( !anySkipEnabled( cfg ) ) return dataToSend;
	const weather = await fetchSkipWeather( weatherProvider, coordinates, pws, adjustmentOptions, now );
	if ( !weather ) return dataToSend; // fail-open: no usable weather
	const result = evaluateSkips( weather, cfg );
	if ( !result.skip ) return dataToSend; // never invent metadata
	return {
		...dataToSend,
		scale: 0,
		rawData: { ...( dataToSend.rawData || {} ), skip: 1, skipReason: result.reason }
	};
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npm test -- --grep "SkipGuard"`
Expected: PASS. Run `npm run compile` (clean).

- [ ] **Step 5: Commit.**

```bash
git add routes/skips/SkipGuard.ts routes/skips/SkipGuard.spec.ts
git commit -m "feat(skips): short-TTL skip-weather memo + fail-open overlay [#weather-skips]"
```

---

## Task 3: Universal `skip`/`skipReason` passthrough in `convertToLegacyFormat`

**Files:**
- Modify: `routes/weather.ts` (`convertToLegacyFormat`)
- Test: `routes/weather.spec.ts` (a focused unit test that calls `convertToLegacyFormat` directly)

- [ ] **Step 1: Export `convertToLegacyFormat` for testing.** In `routes/weather.ts`, change its declaration from `function convertToLegacyFormat(` to `export function convertToLegacyFormat(`. (It currently takes `(enhancedData, adjustmentMethod)`.)

- [ ] **Step 2: Write the failing test.** Add to `routes/weather.spec.ts` (a new top-level `describe`, using the existing imports plus the new one — add `convertToLegacyFormat` and `ManualAdjustmentMethod` imports at the top of the file):

```typescript
import { convertToLegacyFormat } from './weather';
import ManualAdjustmentMethod from './adjustmentMethods/ManualAdjustmentMethod';

describe( 'convertToLegacyFormat skip passthrough', () => {
	it( 'preserves skip / skipReason for any method', () => {
		const enhanced = {
			scale: 0, rd: undefined, tz: 32, sunrise: 100, sunset: 200, eip: 1, errCode: 0,
			rawData: { wp: 'OWM', skip: 1, skipReason: 'freeze: 28F at or below 32F' }
		};
		const out: any = convertToLegacyFormat( enhanced, ManualAdjustmentMethod );
		expect( out.rawData.skip ).to.equal( 1 );
		expect( out.rawData.skipReason ).to.equal( 'freeze: 28F at or below 32F' );
	} );
} );
```

- [ ] **Step 3: Run the test to verify it fails.**

Run: `npm test -- --grep "skip passthrough"`
Expected: FAIL — `out.rawData.skipReason` is `undefined` (the Manual branch keeps only `{ wp }`).

- [ ] **Step 4: Add the passthrough.** In `convertToLegacyFormat`, inside the `if ( enhancedData.rawData ) { ... }` block, **after** the method-specific `if/else if` chain (after the WaterBudget/Zimmerman/ETo branches and before the block closes), add:

```typescript
			// Universal passthrough for cross-cutting weather-skip metadata (applies to ALL methods).
			if ( rawDataSource.skip ) {
				legacyData.rawData.skip = rawDataSource.skip;
				if ( rawDataSource.skipReason !== undefined ) {
					legacyData.rawData.skipReason = rawDataSource.skipReason;
				}
			}
```

(`rawDataSource` is the local alias for `enhancedData.rawData` already used by the method branches; match the file's tab indentation.)

- [ ] **Step 5: Run the test to verify it passes; run the full suite.**

Run: `npm test -- --grep "skip passthrough"` → PASS.
Run: `npm test` → all pass. Run `npm run compile` → clean.

- [ ] **Step 6: Commit.**

```bash
git add routes/weather.ts routes/weather.spec.ts
git commit -m "feat(skips): preserve skip/skipReason through legacy conversion for all methods [#weather-skips]"
```

---

## Task 4: Wire `applyWeatherSkips` into `getWateringData`

**Files:**
- Modify: `routes/weather.ts` (`getWateringData`)
- Test: `routes/weather.spec.ts` (one full-stack route test)

- [ ] **Step 1: Write the failing route test.** This drives a real request through `getWateringData` with `SKIP_FREEZE` enabled and a freezing `getWeatherData`, asserting `scale = 0` and that `skipReason` survives to the legacy response. It reuses the existing `mockGeocoder`/`mockOWMWatering`/`createExpressMocks` helpers and adds a freezing-onecall mock for the skip's `getWeatherData` call. Add inside the existing `describe('Watering Data', ...)` block in `routes/weather.spec.ts`:

```typescript
    it('applies a freeze skip as a live overlay (scale 0 + skipReason survives legacy)', async () => {
        const saved = process.env.SKIP_FREEZE;
        process.env.SKIP_FREEZE = 'on';
        mockGeocoder();
        mockOWMWatering(); // serves getWateringData's day_summary + onecall (Zimmerman path)
        // The skip overlay then calls OWM.getWeatherData -> a SECOND onecall; return a freezing day.
        nock('https://api.openweathermap.org')
            .get('/data/3.0/onecall').query(true)
            .reply(200, {
                current: { temp: 30, humidity: 90, wind_speed: 3, weather: [ { id: 600, main: 'Snow', description: 'snow', icon: '13d' } ] },
                daily: [ { dt: 1557705600, temp: { min: 28, max: 34 }, rain: 0, weather: [ { id: 600, main: 'Snow', description: 'snow', icon: '13d' } ] } ]
            });
        try {
            const expressMocks = createExpressMocks(1, location, '"provider":"OWM"');
            await getWateringData(expressMocks.request, expressMocks.response);
            const body: any = expressMocks.response._getJSON();
            expect( body.scale ).to.equal( 0 );
            expect( body.rawData.skip ).to.equal( 1 );
            expect( body.rawData.skipReason ).to.be.a('string').and.contain('freeze');
        } finally {
            if ( saved === undefined ) { delete process.env.SKIP_FREEZE; } else { process.env.SKIP_FREEZE = saved; }
        }
    });
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- --grep "live overlay"`
Expected: FAIL — `body.scale` is the Zimmerman scale (not 0); `skip`/`skipReason` absent (overlay not wired yet). (A leftover nock interceptor warning is fine.)

- [ ] **Step 3: Wire the overlay.** In `routes/weather.ts`:

  (a) Add the import near the other route imports at the top:

```typescript
import { applyWeatherSkips } from "./skips/SkipGuard";
```

  (b) In `getWateringData`, immediately **after** the cache-hit/miss block closes (the `if ( cachedScale ) { ... } else { ... }` that sets `dataToSend.scale`/`rawData`/`rd`, including the `storeWateringScale` call) and **before** the legacy-conversion line (`let responseData = dataToSend;`), insert:

```typescript
	// Live, additive weather-skip overlay. Runs on every request (cache hit or miss), after the
	// method + restriction have resolved the scale. Returns a fresh object (never mutates the
	// cached result) and only sets scale=0 / skip metadata when a skip actually fires.
	dataToSend = await applyWeatherSkips( dataToSend, weatherProvider, coordinates, pws, adjustmentOptions );
```

  Ensure `dataToSend` is declared with `let` (it already is: `let dataToSend = { ...initialDataStructure };`). `weatherProvider`, `coordinates`, `pws`, and `adjustmentOptions` are all in scope at this point.

- [ ] **Step 4: Run the test to verify it passes; run the full suite.**

Run: `npm test -- --grep "live overlay"` → PASS.
Run: `npm test` → all pass (the prior count plus the new tests). Run `npm run compile` → clean.

- [ ] **Step 5: Commit.**

```bash
git add routes/weather.ts routes/weather.spec.ts
git commit -m "feat(skips): apply live weather-skip overlay in getWateringData [#weather-skips]"
```

> **Spec test-coverage mapping:** the spec's route-level requirements — *cache-hit liveness*, *restriction-already-0 with no skip adds no metadata*, *no-mutation*, *fail-open* — are covered by the `applyWeatherSkips` tests in Task 2 (the overlay IS the route's skip behavior, exercised directly against a provider). Task 4's HTTP test proves the full-stack wiring + legacy `skipReason` round-trip. The cross-method requirement is satisfied because the overlay is method-agnostic (no method branch); Task 3 proves legacy preservation for a non-ETo/Zimmerman method.

---

## Task 5: User documentation

**Files:**
- Create: `docs/weather-skips.md`
- Modify: `README.md` (add a link near the other docs links)

- [ ] **Step 1: Write the docs.** Create `docs/weather-skips.md`:

```markdown
# Weather Skips (Freeze / Wind / Rain)

Three optional guards can force watering to **0%** when conditions make watering
wasteful or risky. They apply to **every** adjustment method and are evaluated
**live on each request** (independent of the daily watering-scale cache).

All three are **off by default** — nothing changes until you enable one.

## Enable / configure (environment variables)

| Guard | Enable | Threshold | Default threshold |
|---|---|---|---|
| Freeze | `SKIP_FREEZE` | `FREEZE_TEMP` | 32 (F) |
| Wind | `SKIP_WIND` | `WIND_MAX` | 25 (mph) |
| Rain | `SKIP_RAIN` | `RAIN_SKIP` | 0.1 (in) |
| (memo) | `SKIP_WEATHER_TTL` | — | 600000 ms (10 min) |

Enable flags accept only `true`, `1`, `yes`, or `on` (case-insensitive); any other
value leaves the guard off. A threshold alone never enables a guard. Each guard can
also be overridden per request via `wto` options: `skipFreeze` / `skipFreezeTemp`,
`skipWind` / `skipWindMax`, `skipRain` / `skipRainThreshold`.

## Behavior

- **Freeze:** skips when the forecast minimum temperature (or current temperature, for
  local/PWS sources that do not report a minimum) is at or below `FREEZE_TEMP`.
- **Wind:** skips when wind speed is at or above `WIND_MAX`.
- **Rain:** skips when the provider's reported precipitation for the current window is at
  or above `RAIN_SKIP`. This is "today already looks wet enough", not a live raindrop
  sensor (the controller's own rain sensor handles real-time rain).

When a guard fires, the response sets `scale = 0` and adds `rawData.skip = 1` and a
human-readable `rawData.skipReason` (e.g. `freeze: 28F at or below 32F`). If weather data
is unavailable, the guards do nothing (watering proceeds) — they never block on missing data.
```

  Add this line to `README.md` near the other docs links:

```markdown
- For optional **freeze / wind / rain skips** (force watering to 0% in bad conditions), see [here](docs/weather-skips.md)
```

- [ ] **Step 2: Verify + commit.**

Run: `npm run compile` (clean) and confirm both files are staged.

```bash
git add docs/weather-skips.md README.md
git commit -m "docs(skips): user guide for freeze/wind/rain skips [#weather-skips]"
```

---

## Done criteria

- `npm test` green (existing suite + new `WeatherSkips`, `SkipGuard`, legacy-passthrough, and route overlay tests), `npm run compile` clean.
- With all `SKIP_*` unset, behavior is **identical** to before (overlay returns the input unchanged; no extra weather fetch).
- Enabling `SKIP_FREEZE` (etc.) forces `scale = 0` live on a triggering request, across any method, with `rawData.skipReason` surviving the legacy response; missing/unavailable weather fails open.

## Out of scope (per spec)
- Refactoring the California restriction to be live / caching only the raw method result (separate follow-up).
- Skip-as-reduction, per-zone skips, dynamic thresholds, live sub-hour rain reactivity.
