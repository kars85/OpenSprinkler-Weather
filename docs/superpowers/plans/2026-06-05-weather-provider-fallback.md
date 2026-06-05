# Weather Provider Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, stateless weather-provider fallback chain — when the active provider fails with a transient/data error (or cannot service the requested method), try the next provider in a configured order — with zero behavior change when unconfigured.

**Architecture:** A `FallbackWeatherProvider` decorator (`implements WeatherProvider`) wraps an ordered chain of providers and is transparent to all call paths (adjustment method, restriction check, `/weather` endpoint). A single `resolveWeatherProvider()` helper in `weather.ts` builds the bare provider (default) or the composite (when a chain is configured), applying the PWS rules. Error classification (`isFallbackEligible`) gates fall-through; auth/config errors never fall through. A forecast-capability regression (the `instanceof EnhancedWeatherProvider` check) is fixed with a structural type guard.

**Tech Stack:** TypeScript (es5/commonjs), Express, mocha + chai + nock (existing test stack). `.mocharc.json` wires `ts-node/register` + `test/setup-env.ts` + `TZ=UTC`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `routes/weatherProviders/FallbackWeatherProvider.ts` | `isFallbackEligible`, `isPwsFallbackEnabled`, `parseFallbackKeys`, `buildFallbackChain`, and the `FallbackWeatherProvider` composite class. | Create |
| `routes/weatherProviders/FallbackWeatherProvider.spec.ts` | Pure unit tests for the classifier, config helpers, and composite (stub providers). | Create |
| `routes/adjustmentMethods/EToAdjustmentMethod.ts` | Replace `instanceof EnhancedWeatherProvider` (`:352`) with an exported structural type guard `supportsForecast`. | Modify |
| `routes/adjustmentMethods/supportsForecast.spec.ts` | Unit tests for the structural capability guard. | Create |
| `routes/adjustmentMethods/AdjustmentMethod.ts` | Add `fallbacks?: string \| string[]` to `AdjustmentOptions`. | Modify |
| `routes/weather.ts` | `resolveWeatherProvider` helper; use it at both selection sites; merge `pwsBypassed` into `rawData`; suppress cache store on fallback; extend `convertToLegacyFormat` passthrough. | Modify |
| `routes/weather.spec.ts` | `resolveWeatherProvider` selection tests + `convertToLegacyFormat` pwsBypassed passthrough test. | Modify |
| `docs/weather-provider-fallback.md` | Operator guide. | Create |
| `README.md` | Link to the operator guide. | Modify |

**Test commands:** subset → `npm test -- --grep "<name>"`; full → `npm test`; type-check → `npm run compile`.

> **Empirica note (this session only):** the sentinel firewall gates praxic commands. If a `git`/`npm`/Edit call is denied with `Epistemic loop closed` / `Run new PREFLIGHT`, open a transaction before retrying: `empirica preflight-submit -` then `empirica check-submit -` (JSON on stdin via heredoc with a `vectors` object; `check-submit` also needs `phase:"praxic"`). Close later with `empirica postflight-submit -`. A normal worker/branch without the sentinel can ignore this.

> **Open verification (from spec §2):** the PWS default (Option A) assumes an OpenSprinkler controller **retains its last successful scale** when the weather call errors. Confirm against firmware before release; if controllers instead default to 100%, revisit flipping `PWS_FALLBACK_ENABLED` to default-on. This does not block implementation.

---

## Task 1: Classifier + config helpers (pure)

**Files:**
- Create: `routes/weatherProviders/FallbackWeatherProvider.ts`
- Test: `routes/weatherProviders/FallbackWeatherProvider.spec.ts`

- [ ] **Step 1: Write the failing tests.** Create `routes/weatherProviders/FallbackWeatherProvider.spec.ts`:

```typescript
import { expect } from "chai";
import { CodedError, ErrorCode } from "../../errors";
import { WeatherProvider } from "./WeatherProvider";
import {
	buildFallbackChain, isFallbackEligible, isPwsFallbackEnabled, parseFallbackKeys
} from "./FallbackWeatherProvider";

describe( "FallbackWeatherProvider.isFallbackEligible", () => {
	it( "advances on transient/data errCodes and unsupported-method", () => {
		for ( const c of [ ErrorCode.BadWeatherData, ErrorCode.InsufficientWeatherData, ErrorCode.MissingWeatherField, ErrorCode.WeatherApiError, ErrorCode.UnsupportedAdjustmentMethod ] ) {
			expect( isFallbackEligible( new CodedError( c ) ), `code ${ c }` ).to.equal( true );
		}
	} );

	it( "does NOT advance on auth/config, location, option, invalid-method, or UnexpectedError", () => {
		for ( const c of [ ErrorCode.InvalidPwsId, ErrorCode.InvalidPwsApiKey, ErrorCode.PwsAuthenticationError, ErrorCode.PwsNotSupported, ErrorCode.NoPwsProvided, ErrorCode.NoAPIKeyProvided, ErrorCode.LocationError, ErrorCode.MissingAdjustmentOption, ErrorCode.InvalidAdjustmentMethod, ErrorCode.UnexpectedError ] ) {
			expect( isFallbackEligible( new CodedError( c ) ), `code ${ c }` ).to.equal( false );
		}
	} );

	it( "advances on network/timeout raw errors only", () => {
		const econn: any = new Error( "connection refused" ); econn.code = "ECONNREFUSED";
		const etimeout: any = new Error( "socket hang up" ); etimeout.code = "ETIMEDOUT";
		const timedOut = new Error( "HTTP request timed out after 10000 ms" );
		expect( isFallbackEligible( econn ) ).to.equal( true );
		expect( isFallbackEligible( etimeout ) ).to.equal( true );
		expect( isFallbackEligible( timedOut ) ).to.equal( true );
	} );

	it( "does NOT advance on arbitrary raw errors (would mask bugs)", () => {
		expect( isFallbackEligible( new Error( "undefined is not a function" ) ) ).to.equal( false );
		expect( isFallbackEligible( "weird" ) ).to.equal( false );
		expect( isFallbackEligible( undefined ) ).to.equal( false );
	} );
} );

describe( "FallbackWeatherProvider.isPwsFallbackEnabled", () => {
	it( "is off unless PWS_FALLBACK_ENABLED is a truthy token", () => {
		expect( isPwsFallbackEnabled( {} ) ).to.equal( false );
		expect( isPwsFallbackEnabled( { PWS_FALLBACK_ENABLED: "false" } ) ).to.equal( false );
		expect( isPwsFallbackEnabled( { PWS_FALLBACK_ENABLED: "true" } ) ).to.equal( true );
		expect( isPwsFallbackEnabled( { PWS_FALLBACK_ENABLED: "ON" } ) ).to.equal( true );
		expect( isPwsFallbackEnabled( { PWS_FALLBACK_ENABLED: "1" } ) ).to.equal( true );
	} );
} );

describe( "FallbackWeatherProvider.parseFallbackKeys", () => {
	it( "returns [] when neither wto nor env is set", () => {
		expect( parseFallbackKeys( {}, {} ) ).to.deep.equal( [] );
		expect( parseFallbackKeys( undefined, {} ) ).to.deep.equal( [] );
	} );

	it( "parses the env CSV (trimmed, non-empty)", () => {
		expect( parseFallbackKeys( {}, { WEATHER_PROVIDER_FALLBACKS: "PW, OpenMeteo ,, Apple" } ) ).to.deep.equal( [ "PW", "OpenMeteo", "Apple" ] );
	} );

	it( "lets wto.fallbacks (array or CSV) override env", () => {
		expect( parseFallbackKeys( { fallbacks: [ "OWM", "DWD" ] }, { WEATHER_PROVIDER_FALLBACKS: "PW" } ) ).to.deep.equal( [ "OWM", "DWD" ] );
		expect( parseFallbackKeys( { fallbacks: "OWM, DWD" }, { WEATHER_PROVIDER_FALLBACKS: "PW" } ) ).to.deep.equal( [ "OWM", "DWD" ] );
	} );
} );

describe( "FallbackWeatherProvider.buildFallbackChain", () => {
	it( "prepends primary, resolves keys via lookup, dedupes, skips unknown", () => {
		const primary = new WeatherProvider();
		const a = new WeatherProvider();
		const b = new WeatherProvider();
		const table: { [ k: string ]: WeatherProvider } = { A: a, B: b };
		const chain = buildFallbackChain( primary, [ "A", "X", "B", "A" ], k => table[ k ] );
		expect( chain ).to.deep.equal( [ primary, a, b ] );
	} );
} );
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "FallbackWeatherProvider"`
Expected: FAIL — `Cannot find module './FallbackWeatherProvider'`.

- [ ] **Step 3: Write the implementation (helpers only).** Create `routes/weatherProviders/FallbackWeatherProvider.ts`:

```typescript
import { GeoCoordinates, PWS, WeatherData, ZimmermanWateringData } from "../../types";
import { WeatherProvider } from "./WeatherProvider";
import { EToData } from "../adjustmentMethods/EToAdjustmentMethod";
import { CodedError, ErrorCode } from "../../errors";

const RAW_NETWORK_CODES = [ "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN" ];

/**
 * Decide whether an error from a provider call should advance to the next provider in the
 * chain. Transient/data errors and unsupported-method advance; auth/config, location, option,
 * invalid-method, and UnexpectedError(99) do NOT (they would fail on every provider, or signal
 * a bug that should surface). Raw (non-Coded) errors advance only when network/timeout-shaped.
 */
export function isFallbackEligible( err: unknown ): boolean {
	if ( err instanceof CodedError ) {
		switch ( err.errCode ) {
			case ErrorCode.BadWeatherData:
			case ErrorCode.InsufficientWeatherData:
			case ErrorCode.MissingWeatherField:
			case ErrorCode.WeatherApiError:
			case ErrorCode.UnsupportedAdjustmentMethod:
				return true;
			default:
				return false;
		}
	}
	const code = ( err as any ) && ( err as any ).code;
	if ( typeof code === "string" && RAW_NETWORK_CODES.indexOf( code ) !== -1 ) return true;
	const msg = ( err as any ) && ( err as any ).message;
	if ( typeof msg === "string" && /timed out/i.test( msg ) ) return true;
	return false;
}

/** Strict enable check for the PWS-fallback opt-in. Accepts true/1/yes/on (case-insensitive). */
export function isPwsFallbackEnabled( env: { [ k: string ]: string | undefined } = process.env as any ): boolean {
	const v = env.PWS_FALLBACK_ENABLED;
	if ( v === undefined || v === null ) return false;
	return [ "true", "1", "yes", "on" ].indexOf( String( v ).trim().toLowerCase() ) !== -1;
}

/**
 * Resolve the ordered list of fallback provider keys: per-request `wto.fallbacks` (array or CSV)
 * overrides the `WEATHER_PROVIDER_FALLBACKS` env CSV. Returns [] when neither is set.
 */
export function parseFallbackKeys(
	adjustmentOptions: { fallbacks?: string | string[] } | undefined,
	env: { [ k: string ]: string | undefined } = process.env as any
): string[] {
	const raw = adjustmentOptions && adjustmentOptions.fallbacks !== undefined
		? adjustmentOptions.fallbacks
		: env.WEATHER_PROVIDER_FALLBACKS;
	if ( raw === undefined || raw === null ) return [];
	const list = Array.isArray( raw ) ? raw : String( raw ).split( "," );
	return list.map( s => String( s ).trim() ).filter( s => s.length > 0 );
}

/**
 * Build a deduped provider chain: [primary, ...resolved fallbacks]. `lookup` maps a provider key
 * to an instance (or undefined for unknown keys, which are skipped).
 */
export function buildFallbackChain(
	primary: WeatherProvider,
	fallbackKeys: string[],
	lookup: ( key: string ) => WeatherProvider | undefined
): WeatherProvider[] {
	const chain: WeatherProvider[] = [ primary ];
	for ( const key of fallbackKeys ) {
		const p = lookup( key );
		if ( p && chain.indexOf( p ) === -1 ) chain.push( p );
	}
	return chain;
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npm test -- --grep "FallbackWeatherProvider"`
Expected: PASS (the composite `describe` does not exist yet — only the four helper describes run). Run `npm run compile` → clean.

- [ ] **Step 5: Commit.**

```bash
git add routes/weatherProviders/FallbackWeatherProvider.ts routes/weatherProviders/FallbackWeatherProvider.spec.ts
git commit -m "feat(fallback): error classifier + chain/config helpers [#weather-provider-fallback]"
```

---

## Task 2: `FallbackWeatherProvider` composite

**Files:**
- Modify: `routes/weatherProviders/FallbackWeatherProvider.ts` (add the class)
- Test: `routes/weatherProviders/FallbackWeatherProvider.spec.ts` (add a `describe`)

- [ ] **Step 1: Write the failing tests.** Append to `routes/weatherProviders/FallbackWeatherProvider.spec.ts`. First add `FallbackWeatherProvider` to the existing import from `./FallbackWeatherProvider` (so it reads `import { buildFallbackChain, FallbackWeatherProvider, isFallbackEligible, isPwsFallbackEnabled, parseFallbackKeys } from "./FallbackWeatherProvider";`), and add `import { GeoCoordinates } from "../../types";` near the top. Then append:

```typescript
describe( "FallbackWeatherProvider (composite)", () => {
	const coords: GeoCoordinates = [ 42.3732, -72.5199 ];

	class Stub extends WeatherProvider {
		public etoCalls = 0;
		constructor( private readonly result: any, private readonly err?: unknown ) { super(); }
		public async getEToData(): Promise< any > {
			this.etoCalls++;
			if ( this.err ) throw this.err;
			return this.result;
		}
		public shouldCacheWateringScale(): boolean { return true; }
	}

	it( "returns the first provider's result without calling the rest", async () => {
		const a = new Stub( { weatherProvider: "OWM" } );
		const b = new Stub( { weatherProvider: "DWD" } );
		const fb = new FallbackWeatherProvider( [ a, b ] );
		const out: any = await fb.getEToData( coords );
		expect( out.weatherProvider ).to.equal( "OWM" );
		expect( a.etoCalls ).to.equal( 1 );
		expect( b.etoCalls ).to.equal( 0 );
		expect( fb.servedFallback ).to.equal( false );
	} );

	it( "advances to the next provider on a transient (eligible) error", async () => {
		const a = new Stub( null, new CodedError( ErrorCode.WeatherApiError ) );
		const b = new Stub( { weatherProvider: "DWD" } );
		const fb = new FallbackWeatherProvider( [ a, b ] );
		const out: any = await fb.getEToData( coords );
		expect( out.weatherProvider ).to.equal( "DWD" );
		expect( a.etoCalls ).to.equal( 1 );
		expect( b.etoCalls ).to.equal( 1 );
		expect( fb.servedFallback ).to.equal( true );
	} );

	it( "rethrows immediately (no advance) on a non-eligible error", async () => {
		const a = new Stub( null, new CodedError( ErrorCode.PwsAuthenticationError ) );
		const b = new Stub( { weatherProvider: "DWD" } );
		const fb = new FallbackWeatherProvider( [ a, b ] );
		let thrown: any;
		try { await fb.getEToData( coords ); } catch ( e ) { thrown = e; }
		expect( thrown ).to.be.instanceOf( CodedError );
		expect( thrown.errCode ).to.equal( ErrorCode.PwsAuthenticationError );
		expect( b.etoCalls ).to.equal( 0 );
	} );

	it( "throws the last error when every provider fails", async () => {
		const a = new Stub( null, new CodedError( ErrorCode.WeatherApiError ) );
		const b = new Stub( null, new CodedError( ErrorCode.InsufficientWeatherData ) );
		const fb = new FallbackWeatherProvider( [ a, b ] );
		let thrown: any;
		try { await fb.getEToData( coords ); } catch ( e ) { thrown = e; }
		expect( thrown.errCode ).to.equal( ErrorCode.InsufficientWeatherData );
	} );

	it( "advances on UnsupportedAdjustmentMethod (capability fallback)", async () => {
		const a = new Stub( null, new CodedError( ErrorCode.UnsupportedAdjustmentMethod ) );
		const b = new Stub( { weatherProvider: "DWD" } );
		const fb = new FallbackWeatherProvider( [ a, b ] );
		const out: any = await fb.getEToData( coords );
		expect( out.weatherProvider ).to.equal( "DWD" );
	} );

	it( "flags pwsBypassed + reason only when primaryIsPws and a fallback served", async () => {
		const pwsP = new Stub( null, new CodedError( ErrorCode.WeatherApiError ) );
		const coord = new Stub( { weatherProvider: "OWM" } );
		const fb = new FallbackWeatherProvider( [ pwsP, coord ], true );
		await fb.getEToData( coords );
		expect( fb.pwsBypassed ).to.equal( true );
		expect( fb.pwsBypassReason ).to.equal( "errCode 12" );
	} );

	it( "does NOT flag pwsBypassed when the PWS primary serves", async () => {
		const pwsP = new Stub( { weatherProvider: "WUnderground" } );
		const coord = new Stub( { weatherProvider: "OWM" } );
		const fb = new FallbackWeatherProvider( [ pwsP, coord ], true );
		await fb.getEToData( coords );
		expect( fb.pwsBypassed ).to.equal( false );
	} );

	it( "shouldCacheWateringScale follows the primary", () => {
		const fb = new FallbackWeatherProvider( [ new Stub( {} ) ] );
		expect( fb.shouldCacheWateringScale() ).to.equal( true );
	} );

	it( "exposes forecast capability from a forecast-capable child", async () => {
		const plain = new Stub( {} );
		const forecaster: any = new Stub( {} );
		forecaster.supportsForecasting = () => true;
		forecaster.getForecastData = async () => [ { confidence: "high" } ];
		forecaster.getBestForecastMethod = () => "full";
		const fb = new FallbackWeatherProvider( [ plain, forecaster ] );
		expect( fb.supportsForecasting() ).to.equal( true );
		expect( fb.getBestForecastMethod( await fb.getForecastData( coords, 3 ) ) ).to.equal( "full" );
	} );

	it( "reports no forecast capability when no child supports it", () => {
		const fb = new FallbackWeatherProvider( [ new Stub( {} ), new Stub( {} ) ] );
		expect( fb.supportsForecasting() ).to.equal( false );
	} );
} );
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "FallbackWeatherProvider \\(composite\\)"`
Expected: FAIL — `FallbackWeatherProvider is not a constructor` (the class is not exported yet).

- [ ] **Step 3: Write the implementation.** Append the class to `routes/weatherProviders/FallbackWeatherProvider.ts`:

```typescript
function describeErr( err: unknown ): string {
	if ( err instanceof CodedError ) return "errCode " + err.errCode;
	const code = ( err as any ) && ( err as any ).code;
	if ( typeof code === "string" ) return code;
	return "error";
}

/**
 * A WeatherProvider that wraps an ordered chain of providers. Each interface method tries the
 * chain in order; on a fallback-eligible error it advances, otherwise it rethrows immediately.
 * If every provider fails, the last error is thrown. Per-request state (servedIndex, bypass
 * reason) lets the caller annotate the response and decide caching.
 *
 * Construct PER REQUEST (a cheap array wrap of singleton providers) so the per-request state is
 * never shared across concurrent requests.
 */
export class FallbackWeatherProvider extends WeatherProvider {
	private servedIndex: number = -1;
	private lastFallbackReason: string | undefined = undefined;

	constructor(
		private readonly chain: WeatherProvider[],
		private readonly primaryIsPws: boolean = false
	) {
		super();
	}

	/** True if a non-primary provider answered the most recent call. */
	public get servedFallback(): boolean {
		return this.servedIndex > 0;
	}

	/** True if the primary was a PWS provider and a non-PWS fallback answered. */
	public get pwsBypassed(): boolean {
		return this.primaryIsPws && this.servedIndex > 0;
	}

	/** A short, non-sensitive reason for the most recent bypass (e.g. "errCode 12"). */
	public get pwsBypassReason(): string | undefined {
		return this.lastFallbackReason;
	}

	private async run< T >( fn: ( p: WeatherProvider ) => Promise< T > ): Promise< T > {
		let lastErr: unknown;
		for ( let i = 0; i < this.chain.length; i++ ) {
			try {
				const result = await fn( this.chain[ i ] );
				this.servedIndex = i;
				return result;
			} catch ( err ) {
				lastErr = err;
				if ( i === this.chain.length - 1 || !isFallbackEligible( err ) ) throw err;
				this.lastFallbackReason = describeErr( err );
			}
		}
		throw lastErr;
	}

	public getWateringData( coordinates: GeoCoordinates, pws?: PWS ): Promise< ZimmermanWateringData > {
		return this.run( p => p.getWateringData( coordinates, pws ) );
	}

	public getEToData( coordinates: GeoCoordinates, pws?: PWS ): Promise< EToData > {
		return this.run( p => p.getEToData( coordinates, pws ) );
	}

	public getWeatherData( coordinates: GeoCoordinates, pws?: PWS ): Promise< WeatherData > {
		return this.run( p => p.getWeatherData( coordinates, pws ) );
	}

	/** Cache eligibility follows the primary provider. */
	public shouldCacheWateringScale(): boolean {
		return this.chain[ 0 ].shouldCacheWateringScale();
	}

	// --- Forecast surface: delegate to the first forecast-capable provider in the chain. ---

	private forecastChild(): any | undefined {
		for ( const p of this.chain ) {
			if ( typeof ( p as any ).supportsForecasting === "function" && ( p as any ).supportsForecasting() ) return p;
		}
		return undefined;
	}

	public supportsForecasting(): boolean {
		return !!this.forecastChild();
	}

	public getForecastCapabilities(): any {
		const c = this.forecastChild();
		return c ? c.getForecastCapabilities() : undefined;
	}

	public getForecastData( coordinates: GeoCoordinates, days: number, pws?: PWS ): Promise< any > {
		const c = this.forecastChild();
		return c ? c.getForecastData( coordinates, days, pws ) : Promise.resolve( [] );
	}

	public getBestForecastMethod( forecastData: any ): any {
		const c = this.forecastChild();
		return c ? c.getBestForecastMethod( forecastData ) : "none";
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npm test -- --grep "FallbackWeatherProvider"`
Expected: PASS (helpers + composite). Run `npm run compile` → clean.

- [ ] **Step 5: Commit.**

```bash
git add routes/weatherProviders/FallbackWeatherProvider.ts routes/weatherProviders/FallbackWeatherProvider.spec.ts
git commit -m "feat(fallback): FallbackWeatherProvider composite (chain, served state, forecast delegation) [#weather-provider-fallback]"
```

---

## Task 3: Structural forecast-capability guard (regression fix)

Wrapping a provider in `FallbackWeatherProvider` makes it no longer `instanceof EnhancedWeatherProvider`, which would silently disable the ETo forecast path. (`instanceof` also already excludes OpenMeteo, whose `EnhancedWeatherProvider` is a *different* class from local's.) Replace the check with a structural **type guard** that preserves type narrowing.

**Files:**
- Modify: `routes/adjustmentMethods/EToAdjustmentMethod.ts:352` (+ a new exported guard)
- Test: `routes/adjustmentMethods/supportsForecast.spec.ts`

- [ ] **Step 1: Write the failing test.** Create `routes/adjustmentMethods/supportsForecast.spec.ts`:

```typescript
import { expect } from "chai";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import { supportsForecast } from "./EToAdjustmentMethod";

describe( "EToAdjustmentMethod.supportsForecast (structural capability guard)", () => {
	it( "is false for a plain WeatherProvider", () => {
		expect( supportsForecast( new WeatherProvider() ) ).to.equal( false );
	} );

	it( "is true for any object exposing supportsForecasting()===true (e.g. the fallback composite)", () => {
		const capable: any = new WeatherProvider();
		capable.supportsForecasting = () => true;
		expect( supportsForecast( capable ) ).to.equal( true );
	} );

	it( "is false when supportsForecasting() returns false", () => {
		const incapable: any = new WeatherProvider();
		incapable.supportsForecasting = () => false;
		expect( supportsForecast( incapable ) ).to.equal( false );
	} );
} );
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- --grep "supportsForecast"`
Expected: FAIL — `supportsForecast is not a function` (not exported yet).

- [ ] **Step 3: Add the guard and use it.** In `routes/adjustmentMethods/EToAdjustmentMethod.ts`:

  (a) Just **after the import block** (the `EnhancedWeatherProvider` import already exists at the top), add the exported guard:

```typescript
/**
 * Structural (duck-typed) capability check that ALSO narrows the type so the forecast block can
 * call the forecast methods. Replaces an `instanceof EnhancedWeatherProvider` check that (a)
 * excluded the FallbackWeatherProvider wrapper and (b) silently excluded OpenMeteo, whose
 * EnhancedWeatherProvider is a different class from local's.
 */
export function supportsForecast( wp: any ): wp is EnhancedWeatherProvider {
	return !!wp && typeof wp.supportsForecasting === "function" && wp.supportsForecasting();
}
```

  (b) Change the condition at line 352 from:

```typescript
    if (weatherProvider instanceof EnhancedWeatherProvider && weatherProvider.supportsForecasting()) {
```

  to:

```typescript
    if (supportsForecast(weatherProvider)) {
```

  Nothing else in the block changes — the type guard narrows `weatherProvider` to `EnhancedWeatherProvider`, so the existing `weatherProvider.getForecastData(...)` / `weatherProvider.getBestForecastMethod(...)` calls still type-check.

- [ ] **Step 4: Run the test + full suite.**

Run: `npm test -- --grep "supportsForecast"` → PASS.
Run: `npm test` → all pass. Run `npm run compile` → clean.

> **Behavior-change callout for the PR:** the structural check also activates the forecast path for a directly-selected OpenMeteo provider (previously dead due to the cross-class `instanceof`). The forecast block is best-effort (gated by `ENABLE_FORECAST`, wrapped in `try/catch` that falls back to historical), so the blast radius is bounded — but note it explicitly in the PR description.

- [ ] **Step 5: Commit.**

```bash
git add routes/adjustmentMethods/EToAdjustmentMethod.ts routes/adjustmentMethods/supportsForecast.spec.ts
git commit -m "fix(fallback): structural forecast-capability guard so the wrapper (and OpenMeteo) keep forecasting [#weather-provider-fallback]"
```

---

## Task 4: `pwsBypassed` passthrough in `convertToLegacyFormat`

**Files:**
- Modify: `routes/weather.ts` (`convertToLegacyFormat`)
- Test: `routes/weather.spec.ts`

- [ ] **Step 1: Write the failing test.** Add to `routes/weather.spec.ts` a new top-level `describe`. `convertToLegacyFormat` and `ManualAdjustmentMethod` are already imported there (from the weather-skips feature); if for any reason they are not, add `import { convertToLegacyFormat } from './weather';` and `import ManualAdjustmentMethod from './adjustmentMethods/ManualAdjustmentMethod';`.

```typescript
describe( 'convertToLegacyFormat pwsBypassed passthrough', () => {
	it( 'preserves pwsBypassed / pwsBypassReason for any method', () => {
		const enhanced = {
			scale: 70, rd: undefined, tz: 32, sunrise: 100, sunset: 200, eip: 1, errCode: 0,
			rawData: { wp: 'OWM', pwsBypassed: 1, pwsBypassReason: 'errCode 12' }
		};
		const out: any = convertToLegacyFormat( enhanced, ManualAdjustmentMethod );
		expect( out.rawData.pwsBypassed ).to.equal( 1 );
		expect( out.rawData.pwsBypassReason ).to.equal( 'errCode 12' );
	} );
} );
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- --grep "pwsBypassed passthrough"`
Expected: FAIL — `out.rawData.pwsBypassReason` is `undefined`.

- [ ] **Step 3: Add the passthrough.** In `routes/weather.ts`, inside `convertToLegacyFormat`'s `if ( enhancedData.rawData ) { ... }` block, **immediately after** the existing universal skip passthrough (the `if ( rawDataSource.skip ) { ... }` block at lines ~140-145) and before that outer block closes, add:

```typescript
			// Universal passthrough for cross-cutting fallback metadata (applies to ALL methods).
			if ( rawDataSource.pwsBypassed ) {
				legacyData.rawData.pwsBypassed = rawDataSource.pwsBypassed;
				if ( rawDataSource.pwsBypassReason !== undefined ) {
					legacyData.rawData.pwsBypassReason = rawDataSource.pwsBypassReason;
				}
			}
```

(Match the file's tab indentation; `rawDataSource` is the local alias already used by the method branches.)

- [ ] **Step 4: Run the test + full suite.**

Run: `npm test -- --grep "pwsBypassed passthrough"` → PASS.
Run: `npm test` → all pass. Run `npm run compile` → clean.

- [ ] **Step 5: Commit.**

```bash
git add routes/weather.ts routes/weather.spec.ts
git commit -m "feat(fallback): preserve pwsBypassed/pwsBypassReason through legacy conversion [#weather-provider-fallback]"
```

---

## Task 5: `resolveWeatherProvider` + wire both selection sites

**Files:**
- Modify: `routes/adjustmentMethods/AdjustmentMethod.ts` (`AdjustmentOptions`)
- Modify: `routes/weather.ts` (new resolver; both call sites; `pwsBypassed` merge; cache suppression)
- Test: `routes/weather.spec.ts`

- [ ] **Step 1: Add the `fallbacks` option.** In `routes/adjustmentMethods/AdjustmentMethod.ts`, extend `AdjustmentOptions`:

```typescript
export interface AdjustmentOptions {
	/** The ID of the PWS to use. */
	pws?: string;
	/** The API key to use to access PWS data. */
	key?: string;
	/** The provider selected using the UI. */
	provider?: string;
	/** Per-request fallback provider chain (array or CSV) overriding WEATHER_PROVIDER_FALLBACKS. */
	fallbacks?: string | string[];
}
```

- [ ] **Step 2: Write the failing tests.** Add to `routes/weather.spec.ts`. Add these imports near the top (alongside the existing `./weather` import): `import { resolveWeatherProvider } from './weather';` and `import { FallbackWeatherProvider } from './weatherProviders/FallbackWeatherProvider';`. Then add:

```typescript
describe( 'resolveWeatherProvider', () => {
	afterEach( () => {
		delete process.env.WEATHER_PROVIDER_FALLBACKS;
		delete process.env.PWS_FALLBACK_ENABLED;
		delete process.env.WEATHER_PROVIDER;
	} );

	it( 'returns a bare provider when no chain is configured', () => {
		const p = resolveWeatherProvider( { provider: 'OWM' } as any, undefined );
		expect( p ).to.not.be.instanceOf( FallbackWeatherProvider );
	} );

	it( 'returns a FallbackWeatherProvider when WEATHER_PROVIDER_FALLBACKS is set', () => {
		process.env.WEATHER_PROVIDER_FALLBACKS = 'DWD,Apple';
		const p = resolveWeatherProvider( { provider: 'OWM' } as any, undefined );
		expect( p ).to.be.instanceOf( FallbackWeatherProvider );
	} );

	it( 'lets wto.fallbacks trigger the composite even when env is unset', () => {
		const p = resolveWeatherProvider( { provider: 'OWM', fallbacks: [ 'DWD' ] } as any, undefined );
		expect( p ).to.be.instanceOf( FallbackWeatherProvider );
	} );

	it( 'honors a PWS with no fallback by default (bare provider)', () => {
		process.env.WEATHER_PROVIDER_FALLBACKS = 'DWD';
		const p = resolveWeatherProvider( { provider: 'WU' } as any, { id: 'KXX', apiKey: 'x' } );
		expect( p ).to.not.be.instanceOf( FallbackWeatherProvider );
	} );

	it( 'adds the chain to the PWS path only when PWS_FALLBACK_ENABLED', () => {
		process.env.WEATHER_PROVIDER_FALLBACKS = 'DWD';
		process.env.PWS_FALLBACK_ENABLED = 'true';
		const p = resolveWeatherProvider( { provider: 'WU' } as any, { id: 'KXX', apiKey: 'x' } );
		expect( p ).to.be.instanceOf( FallbackWeatherProvider );
	} );

	it( 'returns a bare local provider in local mode (no chain)', () => {
		process.env.WEATHER_PROVIDER = 'local';
		process.env.WEATHER_PROVIDER_FALLBACKS = 'DWD';
		const p = resolveWeatherProvider( { provider: 'OWM' } as any, undefined );
		expect( p ).to.not.be.instanceOf( FallbackWeatherProvider );
	} );
} );
```

- [ ] **Step 3: Run the tests to verify they fail.**

Run: `npm test -- --grep "resolveWeatherProvider"`
Expected: FAIL — `resolveWeatherProvider is not a function` (not exported yet).

- [ ] **Step 4: Add the resolver.** In `routes/weather.ts`:

  (a) Add the import near the other route imports (next to the existing `applyWeatherSkips` import):

```typescript
import { buildFallbackChain, FallbackWeatherProvider, isPwsFallbackEnabled, parseFallbackKeys } from "./weatherProviders/FallbackWeatherProvider";
```

  (b) Add the resolver immediately **after** the `PWS_WEATHER_PROVIDER` / `GEOCODER` declarations (around line 33), so it can see `WEATHER_PROVIDERS` and `PWS_WEATHER_PROVIDER`:

```typescript
/**
 * Select the WeatherProvider for a request. Returns a bare provider when no fallback chain is
 * configured (identical to the historical behavior), or a FallbackWeatherProvider composite when
 * a chain is present. PWS default honors the station (bare); the chain is added to the PWS path
 * only when PWS_FALLBACK_ENABLED. Local mode always returns a bare local provider (no chain).
 */
export function resolveWeatherProvider(
	adjustmentOptions: AdjustmentOptions,
	pws: PWS | undefined
): WeatherProvider {
	if ( process.env.WEATHER_PROVIDER === "local" ) {
		return new ( require( "./weatherProviders/local" ).default )();
	}
	const lookup = ( key: string ): WeatherProvider | undefined => WEATHER_PROVIDERS[ key ];
	if ( pws && pws.id ) {
		if ( !isPwsFallbackEnabled() ) return PWS_WEATHER_PROVIDER;
		const pwsChain = buildFallbackChain( PWS_WEATHER_PROVIDER, parseFallbackKeys( adjustmentOptions ), lookup );
		return pwsChain.length > 1 ? new FallbackWeatherProvider( pwsChain, true ) : PWS_WEATHER_PROVIDER;
	}
	const primary = WEATHER_PROVIDERS[ adjustmentOptions.provider ] || WEATHER_PROVIDERS[ "Apple" ];
	const chain = buildFallbackChain( primary, parseFallbackKeys( adjustmentOptions ), lookup );
	return chain.length > 1 ? new FallbackWeatherProvider( chain, false ) : primary;
}
```

- [ ] **Step 5: Run the resolver tests to verify they pass.**

Run: `npm test -- --grep "resolveWeatherProvider"`
Expected: PASS. Run `npm run compile` → clean.

- [ ] **Step 6: Wire the resolver into both selection sites.**

  (a) In `getWeatherData`, replace the provider-selection block (currently, around lines 264-269):

```typescript
	let activeWeatherProvider: WeatherProvider;
	if (process.env.WEATHER_PROVIDER === "local") {
		activeWeatherProvider = new ( require("./weatherProviders/local" ).default )();
	} else {
		activeWeatherProvider = WEATHER_PROVIDERS[adjustmentOptions.provider] || WEATHER_PROVIDERS['Apple'];
	}
```

  with:

```typescript
	let activeWeatherProvider: WeatherProvider = resolveWeatherProvider( adjustmentOptions, pws );
```

  (b) In `getWateringData`, replace the provider-selection block (currently, around lines 346-355):

```typescript
	let weatherProvider: WeatherProvider;
	if( pws && pws.id ){
		weatherProvider = PWS_WEATHER_PROVIDER;
	} else {
		if (process.env.WEATHER_PROVIDER === "local") {
			weatherProvider = new ( require("./weatherProviders/local" ).default )();
		} else {
			weatherProvider = WEATHER_PROVIDERS[adjustmentOptions.provider] || WEATHER_PROVIDERS['Apple'];
		}
	}
```

  with:

```typescript
	let weatherProvider: WeatherProvider = resolveWeatherProvider( adjustmentOptions, pws );
```

  (Note: `/weather` now also honors a configured PWS via the shared resolver — an intentional consistency improvement.)

- [ ] **Step 7: Merge `pwsBypassed` and suppress caching on fallback.** In `getWateringData`'s cache-miss `else` branch:

  (a) **After** the restriction block closes (after the `if ( checkRestrictions ) { ... }` block, around line 408) and **before** the `if ( weatherProvider.shouldCacheWateringScale() )` cache-store, insert:

```typescript
		if ( ( weatherProvider as any ).pwsBypassed && dataToSend.rawData ) {
			dataToSend.rawData = {
				...dataToSend.rawData,
				pwsBypassed: 1,
				pwsBypassReason: ( weatherProvider as any ).pwsBypassReason
			};
		}
```

  (b) Change the cache-store condition (currently `if ( weatherProvider.shouldCacheWateringScale() ) {`, around line 409) to also skip storing when a fallback served:

```typescript
		if ( weatherProvider.shouldCacheWateringScale() && !( weatherProvider as any ).servedFallback ) {
```

  (`servedFallback` / `pwsBypassed` / `pwsBypassReason` are `undefined` on bare providers, so both guards are no-ops unless a `FallbackWeatherProvider` actually fell through.)

- [ ] **Step 8: Run the full suite.**

Run: `npm test` → all pass (existing suite + new resolver/passthrough/composite/guard tests). Run `npm run compile` → clean.

- [ ] **Step 9: Commit.**

```bash
git add routes/weather.ts routes/weather.spec.ts routes/adjustmentMethods/AdjustmentMethod.ts
git commit -m "feat(fallback): resolveWeatherProvider at both sites + pwsBypassed merge + cache suppression [#weather-provider-fallback]"
```

> **Spec test-coverage mapping:** the composite's fall-through, served-tracking, and `pwsBypassed`/`servedFallback`/`pwsBypassReason` getters are proven directly in Task 2; the resolver's bare-vs-composite selection (incl. PWS default vs opt-in and local mode) in Task 5 Step 2; the legacy metadata round-trip in Task 4. The Step-7 inline merge/suppression lines are thin glue over those tested getters (the `as any` access reads the Task-2-verified getters and is a no-op for bare providers). A full HTTP two-provider fall-through test is **intentionally omitted** — it would require brittle dual-provider `nock` fixtures for the ETo/Zimmerman endpoints; the unit coverage above exercises the same logic deterministically. The "no regression when unconfigured" guarantee is covered by the existing route suite continuing to pass (resolver returns the identical bare provider).

---

## Task 6: Operator documentation

**Files:**
- Create: `docs/weather-provider-fallback.md`
- Modify: `README.md`

- [ ] **Step 1: Write the docs.** Create `docs/weather-provider-fallback.md`:

```markdown
# Weather Provider Fallback

When the active weather provider fails with a **transient** error (API down, timeout,
malformed/insufficient data) or cannot service the requested method, the service can
**fall through** to the next provider in a configured chain instead of returning an error.

This is **off by default** — nothing changes until you configure a chain.

## Enable / configure (environment variables)

| Setting | Value | Effect |
|---|---|---|
| `WEATHER_PROVIDER_FALLBACKS` | CSV of provider keys, e.g. `PW,OpenMeteo,Apple` | Ordered fallback chain tried after the primary provider. Unset ⇒ no fallback. |
| `PWS_FALLBACK_ENABLED` | `true` (or `1`/`yes`/`on`) | Also apply the chain to the **PWS** path. Off by default (a PWS failure returns an error, honoring your station choice). |

Provider keys are the same ones used for `provider` in `wto`: `AW`, `PW`, `Apple`, `OWM`,
`OpenMeteo`, `DWD`, `WU`. Unknown keys in the chain are skipped.

Per request, `wto.fallbacks` (an array or CSV) overrides `WEATHER_PROVIDER_FALLBACKS`.

## What does and does not fall through

**Falls through (transient / recoverable):** HTTP/parse/timeout errors, insufficient or
missing weather data, and "this provider can't do the requested method".

**Never falls through (deterministic):** PWS ID/key format errors, PWS authentication
failures, "no API key provided", location errors, and unexpected/bug errors. These would
fail on every provider (or must be fixed by you), so they surface immediately rather than
being masked by a silent provider swap.

## PWS behavior

By default, if you configured a personal weather station and it fails, the service returns
an error rather than silently substituting general-area data from another provider — your
explicit station choice is honored, and a bad API key is never hidden.

Set `PWS_FALLBACK_ENABLED=true` to opt into coordinate-based fallback for the PWS path. A
bad/expired key still fails fast (it is an auth error). When a non-PWS provider serves a
request in this mode, the response carries `rawData.pwsBypassed = 1` and a
`rawData.pwsBypassReason`, so the bypass is visible rather than silent.

## Notes

- Fallback is evaluated fresh on each request (no failure memo). A down primary costs one
  failed call per request until it recovers.
- A watering scale produced by a fallback provider is **not** cached, to avoid pinning a
  coarser result for the rest of the day. `rawData.wp` always reports the provider that
  actually served the data.
```

  Add this line to `README.md` near the other docs links:

```markdown
- For optional **weather provider fallback** (try a backup provider when the primary fails), see [here](docs/weather-provider-fallback.md)
```

- [ ] **Step 2: Verify + commit.**

Run: `npm run compile` (clean) and confirm both files are staged.

```bash
git add docs/weather-provider-fallback.md README.md
git commit -m "docs(fallback): operator guide for weather provider fallback [#weather-provider-fallback]"
```

---

## Done criteria

- `npm test` green (existing suite + new `FallbackWeatherProvider`, `supportsForecast`, `resolveWeatherProvider`, and `pwsBypassed` passthrough tests), `npm run compile` clean.
- With `WEATHER_PROVIDER_FALLBACKS` and `wto.fallbacks` unset, behavior is **identical** to before — `resolveWeatherProvider` returns the same bare provider; no composite is constructed.
- With a chain configured, a transient primary failure transparently falls through to the next provider across all call paths (watering, restriction check, `/weather`); auth/config errors never fall through; a fallback-served scale is not cached and (on the PWS path) is flagged via `rawData.pwsBypassed`/`pwsBypassReason`.
- Wrapping a forecast-capable provider preserves forecasting (structural guard); the OpenMeteo forecast-activation change is noted in the PR.

## Out of scope (per spec §1)
- Circuit breaker / failure memoization, multi-PWS fallback, per-provider health metrics/dashboards.
- The broader "cache the raw method result" refactor and per-provider cache keys.
