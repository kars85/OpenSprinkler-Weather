# Water-Budget per-plant Kc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Water-Budget method apply the per-plant `resolveCropCoefficient` to **demand** while keeping the **reference** on the existing `BUDGET_KC`, so plant choice actually scales watering (the old symmetric kc cancelled out), with env-only config, continuity-preserving defaults, and no state migration.

**Architecture:** Split the single model kc into demand (`params.kc`) vs `referenceKc` in `SoilMoistureModel.step` (reference optional, defaults to kc → backward compatible). `WaterBudgetAdjustmentMethod` resolves the demand kc via the existing `PlantCoefficients.resolveCropCoefficient` reading `BUDGET_`-namespaced env, guards it finite, and records `demandKc`/`kcSource` in the persisted decision so same-day re-polls and legacy responses stay consistent. Metadata is emitted only when a plant/override is active.

**Tech Stack:** TypeScript (es5/commonjs), Express, mocha + chai (existing test stack). `.mocharc.json` wires `ts-node/register` + `test/setup-env.ts` + `TZ=UTC`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `routes/adjustmentMethods/SoilMoistureModel.ts` | `BudgetParams.referenceKc?`; `StepInput.kcSource?`; asymmetric `etc`/`referenceEtc` (`fin`-guarded); record `demandKc`/`kcSource`. | Modify |
| `routes/adjustmentMethods/SoilMoistureModel.spec.ts` | Asymmetric-kc + metadata unit tests. | Modify (append) |
| `routes/adjustmentMethods/WaterBudgetAdjustmentMethod.ts` | `resolveParams.referenceKc`; resolve demand kc (env-only, `BUDGET_`-namespaced, site-tz dayOfYear, NaN guard); pass to `step`; conditional `kc`/`kcSource` in both rawData builders. | Modify |
| `routes/adjustmentMethods/WaterBudgetKc.spec.ts` | Method-level: override/plant flagged, continuity, invalid-override fallback. | Create |
| `routes/weather.ts` | `convertToLegacyFormat` WaterBudget branch forwards `kc`/`kcSource` when present. | Modify |
| `routes/weather.spec.ts` | Legacy passthrough test. | Modify (append) |
| `docs/water-budget.md` + `docs/per-plant-kc.md` | Document Water-Budget Kc env + asymmetric model + carry-forward. | Modify |

**Test commands:** subset → `npm test -- --grep "<name>"`; full → `npm test`; type-check → `npm run compile`.

> **Empirica note (this session only):** the sentinel firewall gates praxic commands. If a `git`/`npm`/Edit call is denied with `Epistemic loop closed` / `Run new PREFLIGHT`, open a transaction before retrying: `empirica preflight-submit -` then `empirica check-submit -` (JSON on stdin via heredoc with a `vectors` object; `check-submit` also needs `phase:"praxic"`). Close later with `empirica postflight-submit -`. A normal worker/branch without the sentinel can ignore this.

---

## Task 1: Asymmetric kc + metadata in `SoilMoistureModel`

**Files:**
- Modify: `routes/adjustmentMethods/SoilMoistureModel.ts`
- Test: `routes/adjustmentMethods/SoilMoistureModel.spec.ts` (append)

- [ ] **Step 1: Write the failing tests.** Append to `routes/adjustmentMethods/SoilMoistureModel.spec.ts`:

```typescript
describe( "SoilMoistureModel asymmetric kc", () => {
	const asymParams = ( kc: number, referenceKc: number ): BudgetParams => ( {
		kc, referenceKc, maxScale: 200, runoffFactor: 1.0, rainBankCapDays: 14, gapResetDays: 2
	} );
	const dryInput = ( over: any = {} ) => ( {
		today: "2019-07-15", eto: 0.25, precip: 0, referenceEto: 0.25, resolvedLocation: undefined, ...over
	} );

	it( "demand kc scales the dry-day scale when it differs from reference kc", () => {
		expect( step( undefined, dryInput({ params: asymParams( 1.0, 0.9 ) }) ).scale ).to.equal( 111 ); // 100*1.0/0.9
		expect( step( undefined, dryInput({ params: asymParams( 0.3, 0.9 ) }) ).scale ).to.equal( 33 );  // 100*0.3/0.9
	} );

	it( "reproduces the symmetric result when demand kc == reference kc (continuity)", () => {
		const r = step( undefined, { today: "2019-07-15", eto: 0.30, precip: 0, referenceEto: 0.20, resolvedLocation: undefined, params: asymParams( 0.9, 0.9 ) } );
		expect( r.scale ).to.equal( 150 ); // kc cancels: 100*0.30/0.20
	} );

	it( "treats a missing referenceKc as equal to kc (backward compatible)", () => {
		const noRef = step( undefined, { today: "2019-07-15", eto: 0.30, precip: 0, referenceEto: 0.20, resolvedLocation: undefined, params: { kc: 0.7, maxScale: 200, runoffFactor: 1.0, rainBankCapDays: 14, gapResetDays: 2 } } );
		expect( noRef.scale ).to.equal( 150 ); // kc cancels, same as symmetric
	} );

	it( "coerces a non-finite demand kc to 0 demand (no NaN in state)", () => {
		const r = step( undefined, dryInput({ params: asymParams( NaN as any, 0.9 ) }) );
		expect( r.scale ).to.equal( 0 );
		expect( Number.isFinite( r.state.rainBank ) ).to.equal( true );
	} );

	it( "records demandKc and kcSource in the decision record", () => {
		const r = step( undefined, dryInput({ kcSource: "plant", params: asymParams( 0.5, 0.9 ) }) );
		const rec = r.state.history[ r.state.history.length - 1 ];
		expect( rec.demandKc ).to.equal( 0.5 );
		expect( rec.kcSource ).to.equal( "plant" );
	} );
} );
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "asymmetric kc"`
Expected: FAIL — `referenceKc` has no effect yet (scale 111 expected but the symmetric model returns 100), and `rec.demandKc` is `undefined`.

- [ ] **Step 3: Implement the model changes.** In `routes/adjustmentMethods/SoilMoistureModel.ts`:

  (a) In the `BudgetParams` interface, after the `kc` field, add `referenceKc`:

```typescript
	/** Crop coefficient applied to reference ETo to get demand. */
	kc: number;
	/** Reference crop coefficient for normalization + bank cap. Defaults to `kc` when omitted. */
	referenceKc?: number;
```

  (b) In the `DecisionRecord` interface, after `reason: string;`, add:

```typescript
	demandKc?: number;
	kcSource?: string;
```

  (c) In the `StepInput` interface, after `params: BudgetParams;`, add:

```typescript
	kcSource?: string;
```

  (d) In `step()`, replace the `etc` / `referenceEtc` lines (currently):

```typescript
	const etc = Math.max( 0, fin( eto ) ) * params.kc;
	const referenceEtc = Math.max( 0, fin( referenceEto ) ) * params.kc;
```

  with (split kc, default reference to kc, and `fin`-guard both coefficients so a non-finite kc can't poison the bank):

```typescript
	const refKc = params.referenceKc === undefined ? params.kc : params.referenceKc;
	const etc = Math.max( 0, fin( eto ) ) * fin( params.kc );
	const referenceEtc = Math.max( 0, fin( referenceEto ) ) * fin( refKc );
```

  (e) In `step()`, add the two new fields to the `record` literal. Replace:

```typescript
	const record: DecisionRecord = {
		date: today, scale,
		eto: round2( eto ), etc: round2( etc ), effectiveRain: round2( effectiveRain ),
		unmetDemand: round2( unmetDemand ), rainBankBefore: round2( rainBankBefore ),
		rainBankAfter: round2( rainBankAfter ), referenceEtc: round2( referenceEtc ),
		resolvedLocation, reason
	};
```

  with:

```typescript
	const record: DecisionRecord = {
		date: today, scale,
		eto: round2( eto ), etc: round2( etc ), effectiveRain: round2( effectiveRain ),
		unmetDemand: round2( unmetDemand ), rainBankBefore: round2( rainBankBefore ),
		rainBankAfter: round2( rainBankAfter ), referenceEtc: round2( referenceEtc ),
		resolvedLocation, reason,
		demandKc: round2( params.kc ), kcSource: input.kcSource
	};
```

- [ ] **Step 4: Run the tests + full suite.**

Run: `npm test -- --grep "SoilMoistureModel"` → PASS (the new `asymmetric kc` describe AND the existing `SoilMoistureModel` describe, which still passes because `referenceKc` defaults to `kc`).
Run: `npm test` → all pass. Run `npm run compile` → clean.

- [ ] **Step 5: Commit.**

```bash
git add routes/adjustmentMethods/SoilMoistureModel.ts routes/adjustmentMethods/SoilMoistureModel.spec.ts
git commit -m "feat(budget-kc): asymmetric demand/reference kc + decision metadata in SoilMoistureModel [#water-budget-kc]"
```

---

## Task 2: Resolve the per-plant demand kc in `WaterBudgetAdjustmentMethod`

**Files:**
- Modify: `routes/adjustmentMethods/WaterBudgetAdjustmentMethod.ts`
- Test: `routes/adjustmentMethods/WaterBudgetKc.spec.ts`

- [ ] **Step 1: Write the failing tests.** Create `routes/adjustmentMethods/WaterBudgetKc.spec.ts`:

```typescript
import { expect } from "chai";
import { WeatherData, ZimmermanWateringData } from "../../types";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import { EToData } from "./EToAdjustmentMethod";
import WaterBudgetAdjustmentMethod from "./WaterBudgetAdjustmentMethod";

class StubProvider extends WeatherProvider {
	constructor( private readonly data: EToData ) { super(); }
	public async getWateringData(): Promise< ZimmermanWateringData > { throw new Error( "n/a" ); }
	public async getWeatherData(): Promise< WeatherData > { throw new Error( "n/a" ); }
	public async getEToData(): Promise< EToData > { return this.data; }
}

function etoData( over: Partial<EToData> = {} ): EToData {
	return {
		weatherProvider: "mock", periodStartTime: 1557705600,
		minTemp: 50, maxTemp: 80, minHumidity: 30, maxHumidity: 80,
		solarRadiation: 6, windSpeed: 4, precip: 0, ...over
	};
}
const opts = { provider: "mock" } as any;

function withEnv( vars: { [ k: string ]: string | undefined }, fn: () => Promise< void > ): Promise< void > {
	const saved: { [ k: string ]: string | undefined } = {};
	for ( const k of Object.keys( vars ) ) {
		saved[ k ] = process.env[ k ];
		if ( vars[ k ] === undefined ) delete process.env[ k ]; else process.env[ k ] = vars[ k ]!;
	}
	return fn().then( () => undefined ).finally( () => {
		for ( const k of Object.keys( saved ) ) {
			if ( saved[ k ] === undefined ) delete process.env[ k ]; else process.env[ k ] = saved[ k ]!;
		}
	} );
}

describe( "WaterBudget per-plant Kc", () => {
	it( "applies a BUDGET_CUSTOM_CROP_COEFFICIENT override to demand and flags it", async () => {
		await withEnv( { BUDGET_PLANT_TYPE: undefined, BUDGET_CUSTOM_CROP_COEFFICIENT: "0.3" }, async () => {
			const res: any = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, [ 42.41, -72.41 ], new StubProvider( etoData() ) );
			expect( res.rawData.kcSource ).to.equal( "override" );
			expect( res.rawData.kc ).to.equal( 0.3 );
			expect( res.rawData.etc ).to.be.closeTo( res.rawData.eto * 0.3, 0.02 );
		} );
	} );

	it( "applies a BUDGET_PLANT_TYPE preset to demand and flags it", async () => {
		await withEnv( { BUDGET_CUSTOM_CROP_COEFFICIENT: undefined, BUDGET_PLANT_TYPE: "vegetable-garden" }, async () => {
			const res: any = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, [ 42.42, -72.42 ], new StubProvider( etoData() ) );
			expect( res.rawData.kcSource ).to.equal( "plant" );
			expect( res.rawData.kc ).to.be.within( 0.3, 1.01 );
			expect( res.rawData.etc ).to.be.closeTo( res.rawData.eto * res.rawData.kc, 0.02 );
		} );
	} );

	it( "adds no kc metadata when unconfigured (continuity)", async () => {
		await withEnv( { BUDGET_PLANT_TYPE: undefined, BUDGET_CUSTOM_CROP_COEFFICIENT: undefined }, async () => {
			const res: any = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, [ 42.43, -72.43 ], new StubProvider( etoData() ) );
			expect( res.rawData.kc ).to.equal( undefined );
			expect( res.rawData.kcSource ).to.equal( undefined );
		} );
	} );

	it( "falls back to reference kc (BUDGET_KC) for an invalid override with no plant", async () => {
		await withEnv( { BUDGET_PLANT_TYPE: undefined, BUDGET_CUSTOM_CROP_COEFFICIENT: "abc", BUDGET_KC: "0.9" }, async () => {
			const res: any = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, [ 42.44, -72.44 ], new StubProvider( etoData() ) );
			expect( res.rawData.kcSource ).to.equal( undefined ); // source "budget" => omitted
			expect( res.rawData.etc ).to.be.closeTo( res.rawData.eto * 0.9, 0.02 );
		} );
	} );
} );
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "WaterBudget per-plant Kc"`
Expected: FAIL — `rawData.kcSource`/`rawData.kc` are `undefined` and `etc` still uses the flat `BUDGET_KC` (the demand-kc wiring doesn't exist yet).

- [ ] **Step 3: Implement the wiring.** In `routes/adjustmentMethods/WaterBudgetAdjustmentMethod.ts`:

  (a) Add the import after the existing `SoilMoistureModel` import (line 8):

```typescript
import { resolveCropCoefficient } from "./PlantCoefficients";
```

  (b) In `resolveParams()`, set `referenceKc = BUDGET_KC` alongside `kc`. Replace:

```typescript
	return {
		kc: envNum( "BUDGET_KC", 0.9 ),
		maxScale: envNum( "BUDGET_MAX_SCALE", 200 ),
		runoffFactor: Math.min( 1, envNonNegativeNum( "BUDGET_RUNOFF", 1.0 ) ),
		rainBankCapDays: envNum( "BUDGET_RAINBANK_CAP_DAYS", 14 ),
		gapResetDays: envNum( "BUDGET_GAP_RESET", 2 )
	};
```

  with:

```typescript
	const baseKc = envNum( "BUDGET_KC", 0.9 );
	return {
		kc: baseKc,
		referenceKc: baseKc,
		maxScale: envNum( "BUDGET_MAX_SCALE", 200 ),
		runoffFactor: Math.min( 1, envNonNegativeNum( "BUDGET_RUNOFF", 1.0 ) ),
		rainBankCapDays: envNum( "BUDGET_RAINBANK_CAP_DAYS", 14 ),
		gapResetDays: envNum( "BUDGET_GAP_RESET", 2 )
	};
```

  (c) Make `buildRawDataFromDecision` emit conditional kc metadata. Replace the whole function:

```typescript
function buildRawDataFromDecision( weatherProvider: string, scale: number, record: DecisionRecord ) {
	return {
		wp: weatherProvider,
		scale,
		eto: record.eto,
		etc: record.etc,
		p: record.effectiveRain,
		bank: round( record.rainBankAfter, 2 ),
		reason: record.reason
	};
}
```

  with:

```typescript
function buildRawDataFromDecision( weatherProvider: string, scale: number, record: DecisionRecord ) {
	const raw: any = {
		wp: weatherProvider,
		scale,
		eto: record.eto,
		etc: record.etc,
		p: record.effectiveRain,
		bank: round( record.rainBankAfter, 2 ),
		reason: record.reason
	};
	if ( record.kcSource && record.kcSource !== "budget" ) {
		raw.kc = record.demandKc;
		raw.kcSource = record.kcSource;
	}
	return raw;
}
```

  (d) Resolve the demand kc and pass it to `step`. Replace the `step` call block (currently):

```typescript
	const { state, scale, reason } = step( prev, {
		today, eto, precip: etoData.precip, referenceEto, resolvedLocation: undefined, params
	} );
	await safeSet( key, state );
	const last = state.history[ state.history.length - 1 ];
```

  with:

```typescript
	const referenceKc = params.referenceKc === undefined ? params.kc : params.referenceKc;
	const dayOfYear = moment.unix( etoData.periodStartTime )
		.tz( geoTZ( coordinates[ 0 ], coordinates[ 1 ] )[ 0 ] ).dayOfYear();
	const kcEnv = {
		PLANT_TYPE: process.env.BUDGET_PLANT_TYPE,
		CUSTOM_CROP_COEFFICIENT: process.env.BUDGET_CUSTOM_CROP_COEFFICIENT
	};
	const resolvedKc = resolveCropCoefficient(
		{}, dayOfYear,
		() => ( { kc: referenceKc, factors: { source: "budget" } } ),
		kcEnv
	);
	let demandKc = resolvedKc.kc;
	if ( !Number.isFinite( demandKc ) || demandKc <= 0 ) demandKc = referenceKc;
	const kcSource: string | undefined = resolvedKc.factors && resolvedKc.factors.source;

	const { state, scale, reason } = step( prev, {
		today, eto, precip: etoData.precip, referenceEto, resolvedLocation: undefined,
		kcSource, params: { ...params, kc: demandKc }
	} );
	await safeSet( key, state );
	const last = state.history[ state.history.length - 1 ];
```

  (e) Update the cold-start fallback rawData (the `: { ... }` branch of the final `return`) to use `demandKc` and emit conditional metadata. Replace:

```typescript
		rawData: last
			? buildRawDataFromDecision( etoData.weatherProvider, scale, last )
			: {
				wp: etoData.weatherProvider,
				scale,
				eto: round( eto, 3 ),
				etc: round( eto * params.kc, 3 ),
				p: round( etoData.precip * params.runoffFactor, 2 ),
				bank: round( state.rainBank, 2 ),
				reason
			},
```

  with:

```typescript
		rawData: last
			? buildRawDataFromDecision( etoData.weatherProvider, scale, last )
			: ( () => {
				const raw: any = {
					wp: etoData.weatherProvider,
					scale,
					eto: round( eto, 3 ),
					etc: round( eto * demandKc, 3 ),
					p: round( etoData.precip * params.runoffFactor, 2 ),
					bank: round( state.rainBank, 2 ),
					reason
				};
				if ( kcSource && kcSource !== "budget" ) { raw.kc = round( demandKc, 2 ); raw.kcSource = kcSource; }
				return raw;
			} )(),
```

- [ ] **Step 4: Run the tests + full suite.**

Run: `npm test -- --grep "WaterBudget per-plant Kc"` → PASS.
Run: `npm test` → all pass (existing `WaterBudgetAdjustmentMethod` suite still green — unconfigured `BUDGET_*` ⇒ `demandKc === referenceKc === BUDGET_KC` ⇒ identical scale/state). Run `npm run compile` → clean.

- [ ] **Step 5: Commit.**

```bash
git add routes/adjustmentMethods/WaterBudgetAdjustmentMethod.ts routes/adjustmentMethods/WaterBudgetKc.spec.ts
git commit -m "feat(budget-kc): resolve per-plant demand kc (env-only) in Water-Budget [#water-budget-kc]"
```

---

## Task 3: Forward `kc`/`kcSource` through legacy conversion

**Files:**
- Modify: `routes/weather.ts` (`convertToLegacyFormat`)
- Test: `routes/weather.spec.ts` (append)

- [ ] **Step 1: Write the failing test.** Append to `routes/weather.spec.ts`. `convertToLegacyFormat` is already imported (from earlier features); add `import WaterBudgetAdjustmentMethod from './adjustmentMethods/WaterBudgetAdjustmentMethod';` near the top if it is not already imported. Then add:

```typescript
describe( 'convertToLegacyFormat WaterBudget kc passthrough', () => {
	it( 'forwards kc / kcSource for the WaterBudget method when present', () => {
		const enhanced = {
			scale: 80, rd: undefined, tz: 32, sunrise: 100, sunset: 200, eip: 1, errCode: 0,
			rawData: { wp: 'WaterBudget', eto: 0.2, etc: 0.16, p: 0, bank: 0, reason: 'Scale 80%: dry conditions.', kc: 0.8, kcSource: 'plant' }
		};
		const out: any = convertToLegacyFormat( enhanced, WaterBudgetAdjustmentMethod );
		expect( out.rawData.kc ).to.equal( 0.8 );
		expect( out.rawData.kcSource ).to.equal( 'plant' );
	} );
} );
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- --grep "WaterBudget kc passthrough"`
Expected: FAIL — `out.rawData.kc` is `undefined` (the WaterBudget legacy branch only copies `eto/etc/p/bank/reason`).

- [ ] **Step 3: Add the passthrough.** In `routes/weather.ts`, in `convertToLegacyFormat`, the WaterBudget branch currently reads:

```typescript
		} else if (adjustmentMethod === WaterBudgetAdjustmentMethod) {
			Object.assign(legacyData.rawData, {
				eto: rawDataSource.eto, etc: rawDataSource.etc, p: rawDataSource.p,
				bank: rawDataSource.bank, reason: rawDataSource.reason
			});
		}
```

  Replace it with:

```typescript
		} else if (adjustmentMethod === WaterBudgetAdjustmentMethod) {
			Object.assign(legacyData.rawData, {
				eto: rawDataSource.eto, etc: rawDataSource.etc, p: rawDataSource.p,
				bank: rawDataSource.bank, reason: rawDataSource.reason
			});
			if ( rawDataSource.kcSource !== undefined ) {
				legacyData.rawData.kc = rawDataSource.kc;
				legacyData.rawData.kcSource = rawDataSource.kcSource;
			}
		}
```

- [ ] **Step 4: Run the test + full suite.**

Run: `npm test -- --grep "WaterBudget kc passthrough"` → PASS.
Run: `npm test` → all pass. Run `npm run compile` → clean.

- [ ] **Step 5: Commit.**

```bash
git add routes/weather.ts routes/weather.spec.ts
git commit -m "feat(budget-kc): forward kc/kcSource through legacy conversion for Water-Budget [#water-budget-kc]"
```

---

## Task 4: Documentation

**Files:**
- Modify: `docs/water-budget.md`
- Modify: `docs/per-plant-kc.md`

- [ ] **Step 1: Document the Water-Budget Kc settings.** Append to `docs/water-budget.md`:

```markdown
## Per-plant crop coefficient (Kc)

Water-Budget applies a crop coefficient to demand. By default this is `BUDGET_KC`
(default 0.9), which acts as the **reference/normal** coefficient. You can make the
**demand** coefficient plant-specific so plant choice scales watering:

| Setting | Default | Effect |
|---|---|---|
| `BUDGET_KC` | 0.9 | Reference/normal crop coefficient (normalization + rain-bank cap), and the default demand Kc when nothing else is set. |
| `BUDGET_PLANT_TYPE` | unset | A plant preset (e.g. `trees`, `shrubs`, `vegetable-garden`, `native` — see the per-plant-Kc guide) whose seasonal curve becomes the **demand** Kc. |
| `BUDGET_CUSTOM_CROP_COEFFICIENT` | unset | An explicit demand Kc (clamped 0.1–1.5; non-numeric ignored). Highest precedence. |

These are **env-only** (Water-Budget advances once per calendar day, so per-request
changes can't take effect mid-day) and are **separate** from the ETo method's
`PLANT_TYPE` / `CUSTOM_CROP_COEFFICIENT` so the two methods don't affect each other.

How it works: demand `ETc = ETo × demandKc`, while the reference stays
`referenceETc = referenceETo × BUDGET_KC`. On a dry day the watering scale becomes
`100 × ETo·demandKc / (referenceETo·BUDGET_KC)`, so a low-water plant (e.g. `native`)
waters less and a thirsty one (e.g. `vegetable-garden`) waters more. With nothing set,
`demandKc = BUDGET_KC` and behavior is unchanged.

When a plant/override is active the response includes `rawData.kc` and `rawData.kcSource`
(`plant` or `override`). Enabling a plant later reuses the existing rain bank (stored as
inches), so there is a brief transition versus a budget that had always used that plant Kc —
this is intentional carry-forward, not a reset.
```

- [ ] **Step 2: Cross-reference from the per-plant-Kc guide.** Append to `docs/per-plant-kc.md`:

```markdown
## Water-Budget method

The Water-Budget method (adjustment method 4) also supports these plant presets, but via
its own **env-only** settings — `BUDGET_PLANT_TYPE` and `BUDGET_CUSTOM_CROP_COEFFICIENT`
(not the `PLANT_TYPE` / `CUSTOM_CROP_COEFFICIENT` used by the ETo method). The preset
catalog and seasonal curves are identical. See the Water-Budget guide for details.
```

- [ ] **Step 3: Verify + commit.**

Run: `npm run compile` (clean) and confirm both files are staged.

```bash
git add docs/water-budget.md docs/per-plant-kc.md
git commit -m "docs(budget-kc): document Water-Budget per-plant Kc env + asymmetric model [#water-budget-kc]"
```

---

## Done criteria

- `npm test` green (existing suites + new asymmetric-kc model tests + Water-Budget Kc method tests + legacy passthrough test), `npm run compile` clean.
- With `BUDGET_PLANT_TYPE` / `BUDGET_CUSTOM_CROP_COEFFICIENT` unset, Water-Budget behaves **identically** to before (demand kc defaults to `BUDGET_KC` → cancels; no `kc`/`kcSource` in rawData; persisted state unchanged).
- Setting `BUDGET_PLANT_TYPE` or `BUDGET_CUSTOM_CROP_COEFFICIENT` makes the demand kc differ from the reference, changing the scale, with `kc`/`kcSource` surfaced in rawData and forwarded through legacy conversion. An invalid override with no plant falls back to `BUDGET_KC`.
- Existing `SoilMoistureModel` and `WaterBudgetAdjustmentMethod` test suites pass unchanged (backward-compatible `referenceKc`).

## Out of scope (per spec)
- Per-request (`wto`) Water-Budget kc; a separate reference-kc env var; changes to the ETo path, the `PlantCoefficients` catalog/dispatcher, or any `BudgetState` schema migration/reset.
- The stale-hold (weather unavailable/incomplete) responses intentionally remain unchanged (no `kc`/`kcSource`) — they did not run the model.
