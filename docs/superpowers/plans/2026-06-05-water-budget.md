# Water-Budget Adjustment Method — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in, stateful "WaterBudget" adjustment method (selector ID `4`) that tracks a per-location rain bank so multi-day rain suppresses watering and dry/hot spells ramp it up — without changing the legacy firmware wire format.

**Architecture:** A new `AdjustmentMethod` implementation reuses the existing `calculateETo` (reference ETo, inches) for demand and the existing `baselineETo` data for the "normal day" reference. A pure `SoilMoistureModel.step()` function (rain-bank model: `unmetDemand = ETc − rainCoverage`, `scale = 100·unmetDemand/referenceETc`) does the math with zero I/O. A thin `StateStore` interface (file adapter, in-memory + atomic flush) persists `{ rainBank, lastUpdated, lastScale, history[] }` keyed by rounded coordinates. The method adds one additive `reason` field to `rawData`; everything else in the response is unchanged.

**Tech Stack:** TypeScript (target es5/commonjs), Express, mocha + chai + nock + mock-express-* (existing test stack), `moment-timezone` + `geo-tz` (existing deps), Node `fs`.

> **Model note (corrected from an earlier draft):** the model is a **rain-bank**, not a deficit accumulator. A deficit accumulator with `deficitCap = 2·ref` pins steady-state dry weather at 200%. The rain-bank model gives the intended ≈100% steady-state dry, 0% during rain memory, and >100% in heat. The spec (`docs/superpowers/specs/2026-06-05-water-budget-design.md`) was updated to match. The `baselineETo` binary stores **one annual-average daily ETo per location** (not day-of-year), so "100%" = a normal day for that location.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `routes/adjustmentMethods/SoilMoistureModel.ts` | Pure rain-bank model: types + `step()` + `daysBetween()`. No I/O. | Create |
| `routes/state/StateStore.ts` | `StateStore` interface + `FileStateStore` (in-memory + atomic flush + corrupt-recovery). | Create |
| `routes/adjustmentMethods/WaterBudgetAdjustmentMethod.ts` | The method: fetch ET/rain, resolve config, run model, persist, build `reason`. | Create |
| `routes/baselineETo.ts` | Export `getBaselineDailyETo(coordinates)` (currently the private `calculateAverageDailyETo`). | Modify |
| `routes/weather.ts` | Register `4: WaterBudgetAdjustmentMethod`; export `ADJUSTMENT_METHOD`; add a WaterBudget branch to `convertToLegacyFormat`. | Modify |
| `routes/adjustmentMethods/SoilMoistureModel.spec.ts` | Pure-model unit tests (the bulk of confidence). | Create |
| `routes/state/FileStateStore.spec.ts` | Store round-trip / atomic / corrupt-recovery tests. | Create |
| `routes/adjustmentMethods/WaterBudgetAdjustmentMethod.spec.ts` | Behavioral integration tests with a mock provider. | Create |
| `routes/weather.spec.ts` | Route-level method-4 test (legacy-format preservation + cache path). | Modify |
| `test/replies.json` | Extend OWM `current` fixture (`clouds`, `wind_speed`) for `getEToData`. | Modify |
| `test/setup-env.ts` | Point `BUDGET_STATE_FILE` at a throwaway temp file for tests. | Modify |
| `.gitignore` | Exclude the default `waterBudgetState.json` runtime file. | Modify |
| `docs/water-budget.md` | User docs: enable, config, state-file hygiene, address input. | Create |

**Test commands:** single test by name → `npm test -- --grep "<name>"`; full suite → `npm test`; type-check → `npm run compile`. The repo's `.mocharc.json` already wires `ts-node/register`, `test/setup-env.ts`, and `TZ=UTC`.

---

## Task 1: Export `getBaselineDailyETo` from `baselineETo.ts`

The model needs the annual-average daily ETo as its "normal day" reference. That value is already computed by the private `calculateAverageDailyETo(coordinates)`; expose it under a clear name.

**Files:**
- Modify: `routes/baselineETo.ts`
- Test: `routes/adjustmentMethods/WaterBudgetAdjustmentMethod.spec.ts` (covers it indirectly in Task 4)

- [ ] **Step 1: Export a named wrapper.** In `routes/baselineETo.ts`, add this exported function just above the existing `async function calculateAverageDailyETo(`:

```typescript
/**
 * The annual-average daily reference ETo (inches/day) for a location, from the
 * shipped baseline ETo data file. Throws { message, code } if the data file is
 * unavailable or the location is out of bounds. Used by the WaterBudget method
 * as the "normal day" reference.
 */
export async function getBaselineDailyETo( coordinates: GeoCoordinates ): Promise< number > {
	return calculateAverageDailyETo( coordinates );
}
```

- [ ] **Step 2: Verify it compiles.**

Run: `npm run compile`
Expected: PASS (`tsc` exits 0, no new errors).

- [ ] **Step 3: Commit.**

```bash
git add routes/baselineETo.ts
git commit -m "feat(baseline): export getBaselineDailyETo for reuse by water budget [#water-budget]"
```

---

## Task 2: Pure `SoilMoistureModel` (types + `step`)

This is the heart of the feature and carries the most test weight. It is a pure function — no I/O, no `Date.now()` (the caller supplies `today`), fully deterministic.

**Files:**
- Create: `routes/adjustmentMethods/SoilMoistureModel.ts`
- Test: `routes/adjustmentMethods/SoilMoistureModel.spec.ts`

- [ ] **Step 1: Write the failing tests.** Create `routes/adjustmentMethods/SoilMoistureModel.spec.ts`:

```typescript
import { expect } from "chai";
import { BudgetParams, BudgetState, daysBetween, HISTORY_CAP, step } from "./SoilMoistureModel";

const params: BudgetParams = {
	kc: 1.0, maxScale: 200, runoffFactor: 1.0, rainBankCapDays: 14, gapResetDays: 2
};

// referenceEto and eto in inches/day; precip in inches.
function input( over: Partial<{ today: string; eto: number; precip: number; referenceEto: number }> = {} ) {
	return {
		today: "2019-05-13", eto: 0.20, precip: 0, referenceEto: 0.20,
		resolvedLocation: undefined, params,
		...over
	};
}

describe( "SoilMoistureModel", () => {
	it( "daysBetween counts whole UTC days", () => {
		expect( daysBetween( "2019-05-13", "2019-05-16" ) ).to.equal( 3 );
		expect( daysBetween( "2019-05-13", "2019-05-13" ) ).to.equal( 0 );
	} );

	it( "normal dry day from cold start scales to 100%", () => {
		const { scale, state } = step( undefined, input() );
		expect( scale ).to.equal( 100 );
		expect( state.rainBank ).to.equal( 0 );
		expect( state.lastUpdated ).to.equal( "2019-05-13" );
	} );

	it( "hot dry day scales above 100% (clamped at maxScale)", () => {
		expect( step( undefined, input({ eto: 0.40 }) ).scale ).to.equal( 200 ); // 0.40/0.20 = 200%
		expect( step( undefined, input({ eto: 1.0 }) ).scale ).to.equal( 200 );  // clamped
	} );

	it( "a big rain bank covers demand and yields 0%, then drains over days", () => {
		// Day 1: 1.0\" rain, demand 0.20\" -> bank 0.80\", scale 0.
		const d1 = step( undefined, input({ today: "2019-05-13", precip: 1.0 }) );
		expect( d1.scale ).to.equal( 0 );
		expect( d1.state.rainBank ).to.be.closeTo( 0.80, 1e-9 );
		// Day 2: no rain, demand 0.20\" drawn from bank -> bank 0.60\", still 0%.
		const d2 = step( d1.state, input({ today: "2019-05-14", precip: 0 }) );
		expect( d2.scale ).to.equal( 0 );
		expect( d2.state.rainBank ).to.be.closeTo( 0.60, 1e-9 );
	} );

	it( "after the bank drains, scale returns to 100%", () => {
		let s: BudgetState | undefined = undefined;
		// Seed a 0.20\" bank then run dry days until empty.
		s = step( s, input({ today: "2019-05-13", precip: 0.40 }) ).state; // bank 0.20
		const day2 = step( s, input({ today: "2019-05-14" }) );           // bank 0 -> unmet 0 -> 0%
		expect( day2.scale ).to.equal( 0 );
		const day3 = step( day2.state, input({ today: "2019-05-15" }) );  // bank empty -> 100%
		expect( day3.scale ).to.equal( 100 );
	} );

	it( "caps rain memory at rainBankCapDays * referenceETc", () => {
		const { state } = step( undefined, input({ precip: 100 }) ); // absurd storm
		expect( state.rainBank ).to.equal( params.rainBankCapDays * 0.20 ); // 14 * 0.20 = 2.8
	} );

	it( "is idempotent for a same-day re-poll", () => {
		const first = step( undefined, input({ today: "2019-05-13", eto: 0.30 }) );
		const second = step( first.state, input({ today: "2019-05-13", eto: 0.99 }) );
		expect( second.scale ).to.equal( first.scale );
		expect( second.state ).to.equal( first.state );
	} );

	it( "resets rain memory after a gap longer than gapResetDays", () => {
		const seeded = step( undefined, input({ today: "2019-05-13", precip: 1.0 }) ).state; // bank 0.80
		const afterGap = step( seeded, input({ today: "2019-05-20" }) ); // 7-day gap > 2
		expect( afterGap.state.rainBank ).to.equal( 0 );
		expect( afterGap.scale ).to.equal( 100 ); // dry, reset -> normal
		expect( afterGap.reason.toLowerCase() ).to.contain( "gap" );
	} );

	it( "bounds the history ring buffer at HISTORY_CAP", () => {
		let s: BudgetState | undefined = undefined;
		for ( let i = 0; i < HISTORY_CAP + 25; i++ ) {
			const day = "2019-" + String( 1 + Math.floor( i / 28 ) ).padStart( 2, "0" ) + "-" + String( 1 + ( i % 28 ) ).padStart( 2, "0" );
			s = step( s, input({ today: day }) ).state;
		}
		expect( s!.history.length ).to.equal( HISTORY_CAP );
	} );

	it( "never returns a scale outside [0, maxScale]", () => {
		expect( step( undefined, input({ eto: -5 }) ).scale ).to.equal( 0 );
		expect( step( undefined, input({ eto: 999 }) ).scale ).to.equal( 200 );
	} );

	it( "treats negative ETo as zero demand and never inflates the rain bank", () => {
		// A negative ETo must not create fake rain memory.
		const d1 = step( undefined, input({ today: "2019-05-13", eto: -0.5, precip: 0 }) );
		expect( d1.scale ).to.equal( 0 );
		expect( d1.state.rainBank ).to.equal( 0 );
		// Even starting from a real bank, a negative-ETo day must not grow it.
		const seeded = step( undefined, input({ today: "2019-05-13", precip: 0.40 }) ).state; // bank 0.20
		const d2 = step( seeded, input({ today: "2019-05-14", eto: -0.5, precip: 0 }) );
		expect( d2.state.rainBank ).to.be.at.most( seeded.rainBank );
	} );
} );
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "SoilMoistureModel"`
Expected: FAIL — `Cannot find module './SoilMoistureModel'` (file not created yet).

- [ ] **Step 3: Write the implementation.** Create `routes/adjustmentMethods/SoilMoistureModel.ts`:

```typescript
export interface BudgetParams {
	/** Crop coefficient applied to reference ETo to get demand. */
	kc: number;
	/** Upper clamp for the returned scale (e.g. 200). */
	maxScale: number;
	/** Fraction of precip counted as effective rain (0..1). */
	runoffFactor: number;
	/** Max days of rain memory: rainBankCap = rainBankCapDays * referenceETc. */
	rainBankCapDays: number;
	/** A gap (in days) longer than this resets the rain memory. */
	gapResetDays: number;
}

export interface DecisionRecord {
	date: string;            // YYYY-MM-DD
	scale: number;
	eto: number;             // reference ETo, inches
	etc: number;             // eto * kc, inches (today's demand)
	effectiveRain: number;   // inches
	unmetDemand: number;     // inches irrigation must cover
	rainBankBefore: number;  // inches
	rainBankAfter: number;   // inches
	referenceEtc: number;    // baselineDailyETo * kc, inches (the 100% normalizer)
	resolvedLocation?: string;
	reason: string;
}

export interface BudgetState {
	rainBank: number;            // inches of stored effective rain
	lastUpdated: string;         // YYYY-MM-DD
	lastScale: number;
	history: DecisionRecord[];   // capped ring buffer
}

export interface StepInput {
	today: string;               // YYYY-MM-DD (caller supplies for determinism)
	eto: number;                 // reference ETo, inches (from calculateETo)
	precip: number;              // inches (from EToData.precip)
	referenceEto: number;        // annual-avg daily baseline ETo, inches
	resolvedLocation?: string;
	params: BudgetParams;
}

export interface StepResult {
	state: BudgetState;
	scale: number;
	reason: string;
}

export const HISTORY_CAP = 90;

function clamp( v: number, lo: number, hi: number ): number {
	return Math.max( lo, Math.min( hi, v ) );
}

function round2( v: number ): number {
	return Math.round( v * 100 ) / 100;
}

/** Whole days between two YYYY-MM-DD strings (b - a). UTC-based and pure. */
export function daysBetween( a: string, b: string ): number {
	const ms = Date.parse( a + "T00:00:00Z" );
	const ms2 = Date.parse( b + "T00:00:00Z" );
	return Math.round( ( ms2 - ms ) / 86400000 );
}

function buildReason( p: {
	scale: number; etc: number; referenceEtc: number; effectiveRain: number;
	rainBankAfter: number; gapReset: boolean; coldStart: boolean; resolvedLocation?: string;
} ): string {
	const loc = p.resolvedLocation ? ` for ${ p.resolvedLocation }` : "";
	const prefix = `Scale ${ p.scale }%: `;
	if ( p.gapReset ) return `${ prefix }resumed after a gap; rain memory reset${ loc }.`;
	if ( p.scale === 0 && p.rainBankAfter > 0 ) return `${ prefix }~${ round2( p.rainBankAfter ) }" of stored rain still covers demand${ loc }.`;
	if ( p.effectiveRain > 0 && p.scale < 100 ) return `${ prefix }recent rain (${ round2( p.effectiveRain ) }") reduces watering need${ loc }.`;
	if ( p.etc > p.referenceEtc ) return `${ prefix }above-normal evaporation (ETc ${ round2( p.etc ) }" vs normal ${ round2( p.referenceEtc ) }")${ loc }.`;
	if ( p.coldStart ) return `${ prefix }first run; watering at a normal level for current conditions${ loc }.`;
	return `${ prefix }dry conditions; watering at ${ p.scale }% of normal${ loc }.`;
}

/**
 * Advance the open-loop rain-bank water budget by one day. Pure: no I/O, no clock.
 */
export function step( prev: BudgetState | undefined, input: StepInput ): StepResult {
	const { today, eto, precip, referenceEto, resolvedLocation, params } = input;
	// Clamp ET to >= 0: calculateETo has no lower bound and can return a small
	// negative value, which would otherwise INFLATE the rain bank (fake memory).
	const etc = Math.max( 0, eto ) * params.kc;
	const referenceEtc = Math.max( 0, referenceEto ) * params.kc;
	const effectiveRain = Math.max( 0, precip ) * params.runoffFactor;

	// Same-day re-poll: return the stored result unchanged (idempotent).
	if ( prev && prev.lastUpdated === today ) {
		const last = prev.history[ prev.history.length - 1 ];
		return { state: prev, scale: prev.lastScale, reason: last ? last.reason : "" };
	}

	// Gap reset: a long outage means we missed days of weather; drop stored memory.
	let rainBankBefore = prev ? prev.rainBank : 0;
	let gapReset = false;
	if ( prev ) {
		const gap = daysBetween( prev.lastUpdated, today );
		if ( gap > params.gapResetDays ) { rainBankBefore = 0; gapReset = true; }
	}

	const available = rainBankBefore + effectiveRain;
	const metByRain = Math.min( etc, available );
	const unmetDemand = Math.max( 0, etc - metByRain );
	const rainBankCap = params.rainBankCapDays * referenceEtc;
	const rainBankAfter = clamp( available - metByRain, 0, rainBankCap );
	const scale = referenceEtc > 0
		? clamp( Math.round( 100 * unmetDemand / referenceEtc ), 0, params.maxScale )
		: 0;

	const reason = buildReason( {
		scale, etc, referenceEtc, effectiveRain, rainBankAfter,
		gapReset, coldStart: !prev, resolvedLocation
	} );

	const record: DecisionRecord = {
		date: today, scale,
		eto: round2( eto ), etc: round2( etc ), effectiveRain: round2( effectiveRain ),
		unmetDemand: round2( unmetDemand ), rainBankBefore: round2( rainBankBefore ),
		rainBankAfter: round2( rainBankAfter ), referenceEtc: round2( referenceEtc ),
		resolvedLocation, reason
	};
	const history = ( prev ? prev.history : [] ).concat( record ).slice( -HISTORY_CAP );

	return {
		state: { rainBank: rainBankAfter, lastUpdated: today, lastScale: scale, history },
		scale, reason
	};
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npm test -- --grep "SoilMoistureModel"`
Expected: PASS (all `SoilMoistureModel` tests green).

- [ ] **Step 5: Commit.**

```bash
git add routes/adjustmentMethods/SoilMoistureModel.ts routes/adjustmentMethods/SoilMoistureModel.spec.ts
git commit -m "feat(water-budget): pure rain-bank soil-moisture model [#water-budget]"
```

---

## Task 3: `StateStore` interface + `FileStateStore`

**Files:**
- Create: `routes/state/StateStore.ts`
- Test: `routes/state/FileStateStore.spec.ts`

- [ ] **Step 1: Write the failing tests.** Create `routes/state/FileStateStore.spec.ts`:

```typescript
import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileStateStore } from "./StateStore";
import { BudgetState } from "../adjustmentMethods/SoilMoistureModel";

let counter = 0;
function tmpFile(): string {
	return path.join( os.tmpdir(), `wb-state-${ process.pid }-${ counter++ }.json` );
}

const sample: BudgetState = { rainBank: 0.4, lastUpdated: "2019-05-13", lastScale: 75, history: [] };

describe( "FileStateStore", () => {
	it( "returns undefined for an unknown key", async () => {
		const store = new FileStateStore( tmpFile() );
		expect( await store.get( "nope" ) ).to.equal( undefined );
	} );

	it( "round-trips a value within an instance", async () => {
		const store = new FileStateStore( tmpFile() );
		await store.set( "42.37,-72.52", sample );
		expect( await store.get( "42.37,-72.52" ) ).to.deep.equal( sample );
	} );

	it( "persists across instances (survives restart)", async () => {
		const file = tmpFile();
		await new FileStateStore( file ).set( "k", sample );
		const reloaded = new FileStateStore( file );
		expect( await reloaded.get( "k" ) ).to.deep.equal( sample );
	} );

	it( "writes atomically and leaves no temp file behind", async () => {
		const file = tmpFile();
		const store = new FileStateStore( file );
		await store.set( "k", sample );
		expect( fs.existsSync( file ) ).to.equal( true );
		const leftovers = fs.readdirSync( os.tmpdir() ).filter( f => f.startsWith( path.basename( file ) ) && f.endsWith( ".tmp" ) );
		expect( leftovers ).to.have.length( 0 );
	} );

	it( "recovers from a corrupt state file (starts empty, no throw)", async () => {
		const file = tmpFile();
		fs.writeFileSync( file, "{ this is not valid json" );
		const store = new FileStateStore( file );
		expect( await store.get( "k" ) ).to.equal( undefined );
		// And it can still write afterward.
		await store.set( "k", sample );
		expect( await store.get( "k" ) ).to.deep.equal( sample );
	} );
} );
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "FileStateStore"`
Expected: FAIL — `Cannot find module './StateStore'`.

- [ ] **Step 3: Write the implementation.** Create `routes/state/StateStore.ts`:

```typescript
import * as fs from "fs";
import { BudgetState } from "../adjustmentMethods/SoilMoistureModel";

/**
 * Persistence seam for water-budget state. The async signature lets a future
 * remote adapter (S3/Redis/Dynamo) drop in unchanged for the hosted service.
 */
export interface StateStore {
	get( key: string ): Promise< BudgetState | undefined >;
	set( key: string, state: BudgetState ): Promise< void >;
}

/**
 * Single-file JSON store. Loads once into an in-memory map (the runtime source
 * of truth) and flushes atomically (temp file -> rename). In-memory-first avoids
 * read-modify-write races and disk thrash. Suited to the self-hosted single/few
 * location case.
 */
export class FileStateStore implements StateStore {
	private readonly path: string;
	private cache: { [ key: string ]: BudgetState } = {};
	private loaded = false;

	public constructor( filePath: string ) {
		this.path = filePath;
	}

	private load(): void {
		if ( this.loaded ) return;
		this.loaded = true;
		try {
			if ( fs.existsSync( this.path ) ) {
				const parsed = JSON.parse( fs.readFileSync( this.path, "utf8" ) );
				if ( parsed && typeof parsed === "object" ) this.cache = parsed;
			}
		} catch ( err ) {
			console.error( "WaterBudget: failed to load state file; starting empty.", err );
			this.cache = {};
		}
	}

	public async get( key: string ): Promise< BudgetState | undefined > {
		this.load();
		return this.cache[ key ];
	}

	public async set( key: string, state: BudgetState ): Promise< void > {
		this.load();
		this.cache[ key ] = state;
		const tmp = `${ this.path }.${ process.pid }.tmp`;
		fs.writeFileSync( tmp, JSON.stringify( this.cache ) );
		fs.renameSync( tmp, this.path );
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npm test -- --grep "FileStateStore"`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add routes/state/StateStore.ts routes/state/FileStateStore.spec.ts
git commit -m "feat(water-budget): pluggable StateStore + atomic FileStateStore [#water-budget]"
```

---

## Task 4: `WaterBudgetAdjustmentMethod`

Wires the model + store + weather provider together, resolves config, and handles errors fail-open. Tests assert behavior that holds regardless of `calculateETo`'s exact output (rain ⇒ 0%, persistence, idempotency, stale-on-failure), using distinct coordinates per case for isolation against the module-singleton store.

**Files:**
- Create: `routes/adjustmentMethods/WaterBudgetAdjustmentMethod.ts`
- Test: `routes/adjustmentMethods/WaterBudgetAdjustmentMethod.spec.ts`

- [ ] **Step 1: Write the failing tests.** Create `routes/adjustmentMethods/WaterBudgetAdjustmentMethod.spec.ts`:

```typescript
import { expect } from "chai";
import { GeoCoordinates, PWS, WeatherData, ZimmermanWateringData } from "../../types";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import { EToData } from "./EToAdjustmentMethod";
import { CodedError, ErrorCode } from "../../errors";
import WaterBudgetAdjustmentMethod from "./WaterBudgetAdjustmentMethod";

// Minimal provider returning canned EToData (or throwing). Amherst-ish coords keep
// calculateETo finite; the exact value doesn't matter for these behavioral assertions.
class StubProvider extends WeatherProvider {
	constructor( private readonly data: EToData | null, private readonly fail = false ) { super(); }
	public async getWateringData(): Promise< ZimmermanWateringData > { throw new Error( "n/a" ); }
	public async getWeatherData(): Promise< WeatherData > { throw new Error( "n/a" ); }
	public async getEToData(): Promise< EToData > {
		if ( this.fail ) throw new CodedError( ErrorCode.WeatherApiError );
		return this.data as EToData;
	}
}

function etoData( over: Partial<EToData> = {} ): EToData {
	return {
		weatherProvider: "mock", periodStartTime: 1557705600, // 2019-05-13 00:00 UTC
		minTemp: 50, maxTemp: 80, minHumidity: 30, maxHumidity: 80,
		solarRadiation: 6, windSpeed: 4, precip: 0, ...over
	};
}

const opts = { provider: "mock" } as any;

describe( "WaterBudgetAdjustmentMethod", () => {
	it( "returns a numeric scale in [0,200] with a reason in rawData", async () => {
		const res = await WaterBudgetAdjustmentMethod.calculateWateringScale(
			opts, [ 42.10, -72.10 ], new StubProvider( etoData() )
		);
		expect( res.scale ).to.be.a( "number" );
		expect( res.scale! ).to.be.within( 0, 200 );
		expect( ( res.rawData as any ).reason ).to.be.a( "string" ).and.contain( "Scale" );
	} );

	it( "yields 0% on a heavy-rain day (rain covers demand regardless of ET)", async () => {
		const res = await WaterBudgetAdjustmentMethod.calculateWateringScale(
			opts, [ 42.11, -72.11 ], new StubProvider( etoData({ precip: 5 }) )
		);
		expect( res.scale ).to.equal( 0 );
	} );

	it( "persists state across calls for the same location (rain memory)", async () => {
		const coords: GeoCoordinates = [ 42.12, -72.12 ];
		// Day 1: soak.
		await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, coords, new StubProvider( etoData({ precip: 5 }) ) );
		// Day 2: dry, but the bank should still suppress watering -> 0%.
		const day2 = await WaterBudgetAdjustmentMethod.calculateWateringScale(
			opts, coords, new StubProvider( etoData({ periodStartTime: 1557792000, precip: 0 }) ) // 2019-05-14
		);
		expect( day2.scale ).to.equal( 0 );
	} );

	it( "is idempotent for a same-day re-poll", async () => {
		const coords: GeoCoordinates = [ 42.13, -72.13 ];
		const a = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, coords, new StubProvider( etoData() ) );
		const b = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, coords, new StubProvider( etoData({ minTemp: 10, maxTemp: 110 }) ) );
		expect( b.scale ).to.equal( a.scale );
	} );

	it( "holds the last scale (flagged stale) when weather fails but state exists", async () => {
		const coords: GeoCoordinates = [ 42.14, -72.14 ];
		const good = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, coords, new StubProvider( etoData() ) );
		const stale = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, coords, new StubProvider( null, true ) );
		expect( stale.scale ).to.equal( good.scale );
		expect( ( stale.rawData as any ).reason.toLowerCase() ).to.contain( "stale" );
	} );

	it( "throws a CodedError when weather fails with no prior state", async () => {
		let threw: any;
		try {
			await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, [ 9.99, 9.99 ], new StubProvider( null, true ) );
		} catch ( e ) { threw = e; }
		expect( threw ).to.be.instanceOf( CodedError );
	} );
} );
```

- [ ] **Step 2: Ensure the store writes to a throwaway file for tests.** In `test/setup-env.ts`, append:

```typescript
// Water-budget state during tests goes to a throwaway file, never the real one.
process.env.BUDGET_STATE_FILE = process.env.BUDGET_STATE_FILE
	|| require( "path" ).join( require( "os" ).tmpdir(), "wb-test-state.json" );
```

Then delete any stale copy once before the suite (so reruns start clean): also in `test/setup-env.ts`, append:

```typescript
try { require( "fs" ).unlinkSync( process.env.BUDGET_STATE_FILE ); } catch ( e ) { /* fine if absent */ }
```

- [ ] **Step 3: Run the tests to verify they fail.**

Run: `npm test -- --grep "WaterBudgetAdjustmentMethod"`
Expected: FAIL — `Cannot find module './WaterBudgetAdjustmentMethod'`.

- [ ] **Step 4: Write the implementation.** Create `routes/adjustmentMethods/WaterBudgetAdjustmentMethod.ts`:

```typescript
import * as moment from "moment-timezone";
import * as geoTZ from "geo-tz";
import { AdjustmentMethod, AdjustmentMethodResponse, AdjustmentOptions } from "./AdjustmentMethod";
import { GeoCoordinates, PWS } from "../../types";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import { calculateETo, EToData, EToScalingAdjustmentOptions } from "./EToAdjustmentMethod";
import { getBaselineDailyETo } from "../baselineETo";
import { BudgetParams, BudgetState, step } from "./SoilMoistureModel";
import { FileStateStore, StateStore } from "../state/StateStore";
import { makeCodedError } from "../../errors";

const DEFAULT_STATE_FILE = __dirname + "/../../waterBudgetState.json";
const store: StateStore = new FileStateStore( process.env.BUDGET_STATE_FILE || DEFAULT_STATE_FILE );

function envNum( name: string, fallback: number ): number {
	const v = Number( process.env[ name ] );
	return Number.isFinite( v ) && v > 0 ? v : fallback;
}

function optNum( value: any, fallback: number ): number {
	const v = Number( value );
	return Number.isFinite( v ) && v > 0 ? v : fallback;
}

// Config is ENV-ONLY in v1. Per-request kc/mx overrides were considered but
// dropped: state advances once per calendar day (same-day re-polls are idempotent),
// so a same-day kc/mx change could not take effect and would mislead. Per-request
// tuning is a deliberate future enhancement.
function resolveParams(): BudgetParams {
	return {
		kc: envNum( "BUDGET_KC", 0.9 ),
		maxScale: envNum( "BUDGET_MAX_SCALE", 200 ),
		runoffFactor: envNum( "BUDGET_RUNOFF", 1.0 ),
		rainBankCapDays: envNum( "BUDGET_RAINBANK_CAP_DAYS", 14 ),
		gapResetDays: envNum( "BUDGET_GAP_RESET", 2 )
	};
}

/** Local calendar date (YYYY-MM-DD) for the data window, in the site's timezone. */
function localDateString( coordinates: GeoCoordinates, periodStartTime: number ): string {
	return moment.unix( periodStartTime ).tz( geoTZ( coordinates[ 0 ], coordinates[ 1 ] )[ 0 ] ).format( "YYYY-MM-DD" );
}

function stateKey( coordinates: GeoCoordinates ): string {
	return `${ coordinates[ 0 ].toFixed( 4 ) },${ coordinates[ 1 ].toFixed( 4 ) }`;
}

async function safeGet( key: string ): Promise< BudgetState | undefined > {
	try { return await store.get( key ); }
	catch ( err ) { console.error( "WaterBudget: state read failed; treating as cold start.", err ); return undefined; }
}

async function safeSet( key: string, state: BudgetState ): Promise< void > {
	try { await store.set( key, state ); }
	catch ( err ) { console.error( "WaterBudget: state write failed; continuing.", err ); }
}

function round( v: number, dp: number ): number {
	const f = Math.pow( 10, dp );
	return Math.round( v * f ) / f;
}

async function calculateWaterBudgetScale(
	adjustmentOptions: AdjustmentOptions,
	coordinates: GeoCoordinates,
	weatherProvider: WeatherProvider,
	pws?: PWS
): Promise< AdjustmentMethodResponse > {
	const params = resolveParams();
	const elevation = optNum( ( adjustmentOptions as EToScalingAdjustmentOptions ).elevation, envNum( "BUDGET_ELEVATION", 600 ) );
	const key = stateKey( coordinates );

	let etoData: EToData;
	try {
		etoData = await weatherProvider.getEToData( coordinates, pws );
	} catch ( err ) {
		// Fail open: if we have prior state, hold the last value (flagged stale); else propagate.
		const prev = await safeGet( key );
		if ( prev ) {
			return {
				scale: prev.lastScale,
				rawData: { wp: "WaterBudget", scale: prev.lastScale, reason: `Scale ${ prev.lastScale }%: weather unavailable, holding last value (stale).` },
				wateringData: { weatherProvider: "WaterBudget" as any, precip: 0 }
			};
		}
		throw makeCodedError( err );
	}

	const eto = calculateETo( etoData, elevation, coordinates );
	const today = localDateString( coordinates, etoData.periodStartTime );

	let referenceEto: number;
	try {
		referenceEto = await getBaselineDailyETo( coordinates );
	} catch ( err ) {
		referenceEto = envNum( "BUDGET_DEFAULT_REF_ETO", 0.15 );
	}

	const prev = await safeGet( key );
	const { state, scale, reason } = step( prev, {
		today, eto, precip: etoData.precip, referenceEto, resolvedLocation: undefined, params
	} );
	await safeSet( key, state );

	return {
		scale,
		rawData: {
			wp: etoData.weatherProvider,
			scale,
			eto: round( eto, 3 ),
			etc: round( eto * params.kc, 3 ),
			p: round( etoData.precip, 2 ),
			bank: round( state.rainBank, 2 ),
			reason
		},
		wateringData: etoData
	};
}

const WaterBudgetAdjustmentMethod: AdjustmentMethod = {
	calculateWateringScale: calculateWaterBudgetScale
};
export default WaterBudgetAdjustmentMethod;
```

> **Note (v1 limitation):** `resolvedLocation` is passed through to the model but left `undefined` because the existing geocoders return coordinates only (no place name). The reason string therefore omits the location suffix. Echoing a friendly place name is a future enhancement gated on extending the geocoder return type — out of scope here.

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `npm test -- --grep "WaterBudgetAdjustmentMethod"`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add routes/adjustmentMethods/WaterBudgetAdjustmentMethod.ts routes/adjustmentMethods/WaterBudgetAdjustmentMethod.spec.ts test/setup-env.ts
git commit -m "feat(water-budget): WaterBudget adjustment method with fail-open errors [#water-budget]"
```

---

## Task 5: Register method `4` in `weather.ts`

**Files:**
- Modify: `routes/weather.ts` (the `ADJUSTMENT_METHOD` map, ~lines 41-46; add an `export`)
- Test: `routes/adjustmentMethods/WaterBudgetAdjustmentMethod.spec.ts` (add a registration assertion)

- [ ] **Step 1: Write the failing test.** First add this import at the **top** of `routes/adjustmentMethods/WaterBudgetAdjustmentMethod.spec.ts`, alongside the other imports (imports must be at module top, not after code):

```typescript
import { ADJUSTMENT_METHOD } from "../weather";
```

Then append this `describe` block at the **end** of the same file:

```typescript
describe( "WaterBudget registration", () => {
	it( "is registered as adjustment method 4", () => {
		expect( ADJUSTMENT_METHOD[ 4 ] ).to.equal( WaterBudgetAdjustmentMethod );
	} );
} );
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- --grep "WaterBudget registration"`
Expected: FAIL — `weather.ts` does not export `ADJUSTMENT_METHOD` (and entry `4` is undefined).

- [ ] **Step 3: Implement the registration.** In `routes/weather.ts`:

  (a) Add the import near the other adjustment-method imports at the top of the file:

```typescript
import WaterBudgetAdjustmentMethod from "./adjustmentMethods/WaterBudgetAdjustmentMethod";
```

  (b) Change the `ADJUSTMENT_METHOD` map declaration from `const ADJUSTMENT_METHOD` to `export const ADJUSTMENT_METHOD` and add entry `4`:

```typescript
export const ADJUSTMENT_METHOD: { [ key: number ] : AdjustmentMethod } = {
	0: ManualAdjustmentMethod,
	1: ZimmermanAdjustmentMethod,
	2: RainDelayAdjustmentMethod,
	3: EToAdjustmentMethod,
	4: WaterBudgetAdjustmentMethod
};
```

- [ ] **Step 4: Run the test + full suite to verify nothing regressed.**

Run: `npm test -- --grep "WaterBudget registration"`
Expected: PASS.
Run: `npm test`
Expected: PASS — all prior tests (6 passing) plus the new water-budget tests, 0 failing.
Run: `npm run compile`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add routes/weather.ts routes/adjustmentMethods/WaterBudgetAdjustmentMethod.spec.ts
git commit -m "feat(water-budget): register WaterBudget as adjustment method 4 [#water-budget]"
```

---

## Task 6: Preserve WaterBudget fields in the legacy response + route-level test

`convertToLegacyFormat()` in `weather.ts` only copies detailed `rawData` for ETo and Zimmerman; every other method is reduced to `{ wp }`. Because `SIMPLIFIED_RESPONSE_FORMAT` defaults on, method 4's `reason`/`bank`/`eto` would be stripped from the response. Add a WaterBudget branch and prove the whole thing end-to-end through `getWateringData` → `convertToLegacyFormat`. This test is the one that would have caught the stripping bug, which the direct-method unit tests miss. (Note: it does **not** exercise the watering-scale cache — the OWM provider's `shouldCacheWateringScale()` is `false`, so the cache is skipped here. The cache path is compatible by inspection — it's keyed per-method and serves the stored `rawData`, advancing state once/day — but is not unit-tested; a caching-provider test is a fast-follow.)

**Files:**
- Modify: `routes/weather.ts` (`convertToLegacyFormat`, the method-specific `rawData` branches)
- Modify: `test/replies.json` (extend the OWM `current` fixture so `getEToData` has `clouds` + `wind_speed`)
- Test: `routes/weather.spec.ts` (route-level method-4 assertion)

- [ ] **Step 1: Extend the OWM fixture for `getEToData`.** Method 4 calls `weatherProvider.getEToData`, which (for OWM) reads `current.clouds` and `current.wind_speed` — fields the existing `OWMToday` fixture lacks. Add them (additive; does not affect the existing Zimmerman test):

```bash
node -e "const fs=require('fs');const p='./test/replies.json';const r=JSON.parse(fs.readFileSync(p,'utf8'));r['01002'].OWMToday.current.clouds=20;r['01002'].OWMToday.current.wind_speed=5;fs.writeFileSync(p,JSON.stringify(r,null,2)+'\n');console.log('extended OWMToday.current with clouds + wind_speed');"
```

- [ ] **Step 2: Write the failing route test.** Append this `it` inside the existing `describe('Watering Data', ...)` block in `routes/weather.spec.ts` (it reuses the existing `mockGeocoder`, `mockOWMWatering`, and `createExpressMocks` helpers):

```typescript
    it('Water Budget Lookup (Adjustment Method 4, Location 01002)', async () => {
        mockGeocoder();
        mockOWMWatering();

        const expressMocks = createExpressMocks(4, location, '"provider":"OWM"');
        await getWateringData(expressMocks.request, expressMocks.response);

        const body: any = expressMocks.response._getJSON();
        expect( body.scale ).to.be.a('number');
        expect( body.scale ).to.be.within(0, 200);
        // The additive reason must survive convertToLegacyFormat (SIMPLIFIED_RESPONSE_FORMAT is on).
        expect( body.rawData ).to.be.an('object');
        expect( body.rawData.reason ).to.be.a('string').and.contain('Scale');
    });
```

- [ ] **Step 3: Run the test to verify it fails.**

Run: `npm test -- --grep "Water Budget Lookup"`
Expected: FAIL — `body.rawData.reason` is `undefined` because `convertToLegacyFormat` reduced method-4 `rawData` to `{ wp }`.

- [ ] **Step 4: Add the WaterBudget branch to `convertToLegacyFormat`.** In `routes/weather.ts`, find the method-specific block inside `convertToLegacyFormat` and add a `WaterBudgetAdjustmentMethod` branch after the Zimmerman one (the `WaterBudgetAdjustmentMethod` import was added in Task 5):

```typescript
			} else if (adjustmentMethod === ZimmermanAdjustmentMethod) {
				Object.assign(legacyData.rawData, {
					h: rawDataSource.h, p: rawDataSource.p, t: rawDataSource.t, raining: rawDataSource.raining
				});
			} else if (adjustmentMethod === WaterBudgetAdjustmentMethod) {
				Object.assign(legacyData.rawData, {
					eto: rawDataSource.eto, etc: rawDataSource.etc, p: rawDataSource.p,
					bank: rawDataSource.bank, reason: rawDataSource.reason
				});
			}
```

- [ ] **Step 5: Run the test to verify it passes; run the full suite.**

Run: `npm test -- --grep "Water Budget Lookup"`
Expected: PASS.
Run: `npm test`
Expected: PASS — all existing + new tests, 0 failing.

- [ ] **Step 6: Commit.**

```bash
git add routes/weather.ts test/replies.json routes/weather.spec.ts
git commit -m "feat(water-budget): preserve reason/bank in legacy response + route-level test [#water-budget]"
```

---

## Task 7: User documentation, state-file hygiene & ops

**Files:**
- Create: `docs/water-budget.md`
- Modify: `README.md` (add a link under the methods/features list)
- Modify: `.gitignore` (exclude the default state file)

- [ ] **Step 0: Stop the runtime state file from being committed.** The default `BUDGET_STATE_FILE` (`waterBudgetState.json`) is runtime data, like `geocoderCache.json`. Add it to `.gitignore` under the existing "Runtime/cache data" section:

```gitignore
# Runtime/cache data generated by running service
geocoderCache.json
observations.json
waterBudgetState.json
```

Run: `npm run compile && git check-ignore waterBudgetState.json`
Expected: prints `waterBudgetState.json` (confirming it is ignored).

- [ ] **Step 1: Write the docs.** Create `docs/water-budget.md`:

```markdown
# Water-Budget Watering (Adjustment Method 4)

The Water-Budget method tracks a per-location **rain bank** so that watering
remembers recent rain across days and ramps up during dry/hot spells. Select it
by using adjustment method `4`.

## How it works

Each day the service computes reference evapotranspiration (ET) for your location
and compares it to the local annual-average normal. Effective rainfall is banked
and used to cover demand on following days:

- A normal dry day → ~100% (normal watering).
- After rain → 0% until the banked rain drains (multi-day memory).
- A heat wave → above 100% (up to the configured maximum).

State is stored locally in a JSON file; this method is intended for self-hosted
installations.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `BUDGET_KC` | 0.9 | Crop coefficient (plant water-use factor). |
| `BUDGET_MAX_SCALE` | 200 | Maximum watering scale (%). |
| `BUDGET_RUNOFF` | 1.0 | Fraction of rainfall counted as effective. |
| `BUDGET_RAINBANK_CAP_DAYS` | 14 | Maximum days of rain memory. |
| `BUDGET_GAP_RESET` | 2 | Outage length (days) that resets rain memory. |
| `BUDGET_ELEVATION` | 600 | Site elevation in feet (for ET). |
| `BUDGET_DEFAULT_REF_ETO` | 0.15 | Fallback normal daily ET (in) if baseline data is unavailable. |
| `BUDGET_STATE_FILE` | `waterBudgetState.json` | Path to the state file. |

Configuration is environment-only in this version; changes apply on the next
service restart (the budget advances once per day, so per-request tuning is not
supported yet).

## State persistence

This method keeps a small per-location state file (rain bank + recent history).
By default it is written to `waterBudgetState.json` next to the service. In a
container or read-only deployment, set `BUDGET_STATE_FILE` to a path on a mounted,
writable volume so the state survives restarts and redeploys (the file is
git-ignored and must not be baked into the image). If the file is lost, the
budget simply restarts from a neutral state.

## Location / address input

The `loc` parameter accepts a ZIP code, place name, GPS pair (`lat,lon`), or a
**street address**. For best street-address accuracy set `GEOCODER=GoogleMaps`
and provide `GOOGLE_MAPS_API_KEY`; the default geocoder is tuned for ZIP/place
names.
```

  Then add this line to `README.md` near the other docs links (for example after the WeeWX / providers section):

```markdown
- For multi-day, rain-aware **Water-Budget** watering (adjustment method 4), see [here](docs/water-budget.md)
```

- [ ] **Step 2: Verify the docs render (no broken table / link).**

Run: `git add docs/water-budget.md README.md .gitignore && git status --short`
Expected: all three files staged; visually confirm the table and link look correct.

- [ ] **Step 3: Commit.**

```bash
git commit -m "docs(water-budget): user guide, state-file hygiene, and gitignore [#water-budget]"
```

---

## Done criteria

- `npm test` is green (existing 6 + new SoilMoistureModel / FileStateStore / WaterBudget unit tests + the route-level method-4 test), `npm run compile` clean.
- Selecting adjustment method `4` **through the route** returns a `scale` and a `rawData.reason` that survives `convertToLegacyFormat` (the additive `reason`/`bank`/`eto` are preserved; the legacy response still parses).
- Rain on a prior day suppresses today's scale; a negative ETo never inflates the rain bank; steady-state dry ≈ 100%.
- State persists to `BUDGET_STATE_FILE`, is bounded (≤ 90 history records/location), and `waterBudgetState.json` is git-ignored (never committed or baked into the image).

## Out of scope (future cycles, per spec)
- Dashboard/trends UI over the decision log.
- Hosted multi-tenant `StateStore` adapter + tenant identity + keyspace eviction.
- Closed-loop firmware telemetry; dynamic per-season Kc; friendly resolved place name in `reason`.
