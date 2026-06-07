# Per-plant Kc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a crop-coefficient (Kc) override plus a catalog of named plant presets — each a Northern-hemisphere day-of-year seasonal Kc curve — to the ETo adjustment method, selected via a small precedence dispatcher that leaves the existing turfgrass engine untouched.

**Architecture:** A standalone, pure `routes/adjustmentMethods/PlantCoefficients.ts` (catalog + curve + clamp + `resolveCropCoefficient` dispatcher). The dispatcher precedence is `customCropCoefficient override → plant preset → turfFallback() → default`. The turf branch is **injected as a thunk**, so the module never imports `TurfgrassManager` (no import cycle) and is fully unit-testable. `EToAdjustmentMethod` calls the dispatcher inside its existing `enableCropCoefficient` block.

**Tech Stack:** TypeScript (es5/commonjs), Express, mocha + chai (existing test stack). `.mocharc.json` wires `ts-node/register` + `test/setup-env.ts` + `TZ=UTC`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `routes/adjustmentMethods/PlantCoefficients.ts` | `PlantType`, `PLANT_KC_CATALOG`, `KC_MIN`/`KC_MAX`, `clampKc`, `getPlantKc`, `resolveCropCoefficient`. Pure, no `TurfgrassManager` import. | Create |
| `routes/adjustmentMethods/PlantCoefficients.spec.ts` | Pure unit tests (clamp, curve, dispatcher precedence with a mock turf fallback). | Create |
| `routes/adjustmentMethods/EToAdjustmentMethod.ts` | Add `plantType` to `EToScalingAdjustmentOptions`; replace the direct `TurfgrassManager.calculateCropCoefficient(...)` call with `resolveCropCoefficient(adjustmentOptions, dayOfYear, () => TurfgrassManager.calculateCropCoefficient(...))`. | Modify |
| `routes/adjustmentMethods/EToCropCoefficient.spec.ts` | Integration test: stub ETo provider → override and plant preset reflected in `rawData.crop_coefficient`/`crop_factors`. | Create |
| `docs/per-plant-kc.md` + `README.md` | User guide + link. | Create/Modify |

**Test commands:** subset → `npm test -- --grep "<name>"`; full → `npm test`; type-check → `npm run compile`.

> **Empirica note (this session only):** the sentinel firewall gates praxic commands. If a `git`/`npm`/Edit call is denied with `Epistemic loop closed` / `Run new PREFLIGHT`, open a transaction before retrying: `empirica preflight-submit -` then `empirica check-submit -` (JSON on stdin via heredoc with a `vectors` object; `check-submit` also needs `phase:"praxic"`). Close later with `empirica postflight-submit -`. A normal worker/branch without the sentinel can ignore this.

---

## Task 1: `PlantCoefficients` — catalog, curve, clamp

**Files:**
- Create: `routes/adjustmentMethods/PlantCoefficients.ts`
- Test: `routes/adjustmentMethods/PlantCoefficients.spec.ts`

- [ ] **Step 1: Write the failing tests.** Create `routes/adjustmentMethods/PlantCoefficients.spec.ts`:

```typescript
import { expect } from "chai";
import { clampKc, getPlantKc, KC_MAX, KC_MIN, PLANT_KC_CATALOG } from "./PlantCoefficients";

describe( "PlantCoefficients.clampKc", () => {
	it( "returns a finite value clamped to [0.1, 1.5]", () => {
		expect( clampKc( 0.65 ) ).to.equal( 0.65 );
		expect( clampKc( 5 ) ).to.equal( KC_MAX );
		expect( clampKc( -2 ) ).to.equal( KC_MIN );
		expect( clampKc( "0.8" ) ).to.equal( 0.8 );
	} );
	it( "returns undefined for non-finite input", () => {
		expect( clampKc( undefined ) ).to.equal( undefined );
		expect( clampKc( NaN ) ).to.equal( undefined );
		expect( clampKc( "abc" ) ).to.equal( undefined );
		expect( clampKc( null ) ).to.equal( undefined );
	} );
} );

describe( "PlantCoefficients.getPlantKc", () => {
	it( "peaks at the summer peak day and bottoms half a year away", () => {
		const peak = getPlantKc( "vegetable-garden", 196 );
		const trough = getPlantKc( "vegetable-garden", 14 ); // ~182 days from peak
		expect( peak ).to.equal( 1.0 );
		expect( trough ).to.be.closeTo( 0.30, 0.02 );
		expect( peak ).to.be.greaterThan( trough );
	} );
	it( "stays within [dormantKc, peakKc] and global bounds for every catalog entry across the year", () => {
		for ( const key of Object.keys( PLANT_KC_CATALOG ) ) {
			const { dormantKc, peakKc } = PLANT_KC_CATALOG[ key ];
			for ( let d = 1; d <= 365; d += 30 ) {
				const kc = getPlantKc( key, d );
				expect( kc, `${ key }@${ d }` ).to.be.within( dormantKc - 0.01, peakKc + 0.01 );
				expect( kc ).to.be.within( KC_MIN, KC_MAX );
			}
		}
	} );
	it( "returns 1.0 for an unknown plant type", () => {
		expect( getPlantKc( "spaceship", 100 ) ).to.equal( 1.0 );
	} );
} );
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "PlantCoefficients.clampKc|PlantCoefficients.getPlantKc"`
Expected: FAIL — `Cannot find module './PlantCoefficients'`.

- [ ] **Step 3: Write the implementation.** Create `routes/adjustmentMethods/PlantCoefficients.ts`:

```typescript
export type PlantType =
	| "trees" | "shrubs" | "groundcover" | "perennials"
	| "annual-flowers" | "vegetable-garden" | "native";

export interface PlantKc {
	/** Dormant-season (winter) crop coefficient floor. */
	dormantKc: number;
	/** Peak growing-season (summer) crop coefficient. */
	peakKc: number;
	/** Day-of-year of the seasonal peak (Northern hemisphere). Defaults to 196 (~Jul 15). */
	peakDay?: number;
}

export const KC_MIN = 0.1;
export const KC_MAX = 1.5;
const DEFAULT_PEAK_DAY = 196;

/** Named plant presets -> seasonal Kc curve parameters. Approximate FAO-56 / WUCOLS values. */
export const PLANT_KC_CATALOG: { [ k: string ]: PlantKc } = {
	"trees":            { dormantKc: 0.40, peakKc: 0.65 },
	"shrubs":           { dormantKc: 0.30, peakKc: 0.50 },
	"groundcover":      { dormantKc: 0.30, peakKc: 0.50 },
	"perennials":       { dormantKc: 0.20, peakKc: 0.50 },
	"annual-flowers":   { dormantKc: 0.20, peakKc: 0.80 },
	"vegetable-garden": { dormantKc: 0.30, peakKc: 1.00 },
	"native":           { dormantKc: 0.15, peakKc: 0.30 }
};

/**
 * Coerce a value to a finite crop coefficient clamped to [KC_MIN, KC_MAX], or undefined if the
 * value is not a finite number. Used so a junk override falls through instead of zeroing watering.
 */
export function clampKc( value: any ): number | undefined {
	const n = Number( value );
	if ( !Number.isFinite( n ) ) return undefined;
	return Math.min( KC_MAX, Math.max( KC_MIN, n ) );
}

/**
 * Seasonal crop coefficient for a plant preset on a given day-of-year. Cosine interpolation
 * between the dormant floor (winter) and the peak (summer); peaks at `peakDay`. Northern
 * hemisphere. Returns a value rounded to 2 decimals, always within [dormantKc, peakKc].
 * Falls back to 1.0 for an unknown plant type.
 */
export function getPlantKc( plantType: string, dayOfYear: number ): number {
	const plant = PLANT_KC_CATALOG[ plantType ];
	if ( !plant ) return 1.0;
	const peakDay = plant.peakDay === undefined ? DEFAULT_PEAK_DAY : plant.peakDay;
	const phase = ( ( dayOfYear - peakDay ) / 365 ) * 2 * Math.PI;
	const kc = plant.dormantKc + ( plant.peakKc - plant.dormantKc ) * ( 1 + Math.cos( phase ) ) / 2;
	return Math.round( kc * 100 ) / 100;
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npm test -- --grep "PlantCoefficients.clampKc|PlantCoefficients.getPlantKc"`
Expected: PASS. Run `npm run compile` → clean.

- [ ] **Step 5: Commit.**

```bash
git add routes/adjustmentMethods/PlantCoefficients.ts routes/adjustmentMethods/PlantCoefficients.spec.ts
git commit -m "feat(kc): plant Kc catalog, seasonal curve, and clamp [#per-plant-kc]"
```

---

## Task 2: `resolveCropCoefficient` dispatcher

**Files:**
- Modify: `routes/adjustmentMethods/PlantCoefficients.ts` (append the dispatcher)
- Test: `routes/adjustmentMethods/PlantCoefficients.spec.ts` (append a `describe`)

- [ ] **Step 1: Write the failing tests.** Append to `routes/adjustmentMethods/PlantCoefficients.spec.ts`. Add `resolveCropCoefficient` to the existing import from `./PlantCoefficients` (so it reads `import { clampKc, getPlantKc, KC_MAX, KC_MIN, PLANT_KC_CATALOG, resolveCropCoefficient } from "./PlantCoefficients";`), then append:

```typescript
describe( "PlantCoefficients.resolveCropCoefficient", () => {
	const turf = (): any => ( { kc: 0.85, factors: { source: "turf" } } );

	it( "override wins over plant and turf (clamped)", () => {
		const r = resolveCropCoefficient( { customCropCoefficient: 0.5, plantType: "trees" }, 196, turf, {} );
		expect( r.kc ).to.equal( 0.5 );
		expect( r.factors.source ).to.equal( "override" );
	} );

	it( "a non-finite override falls through to the plant preset", () => {
		const r = resolveCropCoefficient( { customCropCoefficient: NaN, plantType: "vegetable-garden" }, 196, turf, {} );
		expect( r.kc ).to.equal( 1.0 );
		expect( r.factors.source ).to.equal( "plant" );
	} );

	it( "a known plantType wins over turf", () => {
		const r = resolveCropCoefficient( { plantType: "native" }, 196, turf, {} );
		expect( r.factors ).to.deep.equal( { source: "plant", plantType: "native" } );
	} );

	it( "an unknown plantType falls through to turf", () => {
		const r = resolveCropCoefficient( { plantType: "spaceship" }, 196, turf, {} );
		expect( r.factors.source ).to.equal( "turf" );
		expect( r.kc ).to.equal( 0.85 );
	} );

	it( "no override and no plantType uses the turf fallback", () => {
		const r = resolveCropCoefficient( {}, 196, turf, {} );
		expect( r.factors.source ).to.equal( "turf" );
	} );

	it( "reads env CUSTOM_CROP_COEFFICIENT and PLANT_TYPE when opts are absent", () => {
		expect( resolveCropCoefficient( {}, 196, turf, { CUSTOM_CROP_COEFFICIENT: "0.7" } ).kc ).to.equal( 0.7 );
		expect( resolveCropCoefficient( {}, 196, turf, { PLANT_TYPE: "trees" } ).factors.source ).to.equal( "plant" );
	} );
} );
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "PlantCoefficients.resolveCropCoefficient"`
Expected: FAIL — `resolveCropCoefficient is not a function`.

- [ ] **Step 3: Write the implementation.** Append to `routes/adjustmentMethods/PlantCoefficients.ts`:

```typescript
export interface CropCoefficientResult {
	kc: number;
	factors: any;
}

/**
 * Resolve the crop coefficient by precedence:
 *   1. customCropCoefficient override (finite, clamped to [KC_MIN, KC_MAX])
 *   2. a known plantType preset's seasonal Kc curve
 *   3. turfFallback() — the existing TurfgrassManager grass path (unchanged)
 * `turfFallback` is injected so this module never imports TurfgrassManager (no cycle) and stays
 * unit-testable. `env` is injectable for tests; defaults to process.env.
 */
export function resolveCropCoefficient(
	opts: { customCropCoefficient?: number; plantType?: string },
	dayOfYear: number,
	turfFallback: () => CropCoefficientResult,
	env: { [ k: string ]: string | undefined } = process.env as any
): CropCoefficientResult {
	const rawOverride = opts.customCropCoefficient !== undefined ? opts.customCropCoefficient : env.CUSTOM_CROP_COEFFICIENT;
	const override = clampKc( rawOverride );
	if ( override !== undefined ) {
		return { kc: override, factors: { source: "override" } };
	}
	const plantType = opts.plantType !== undefined ? opts.plantType : env.PLANT_TYPE;
	if ( plantType && PLANT_KC_CATALOG[ plantType ] ) {
		return { kc: getPlantKc( plantType, dayOfYear ), factors: { source: "plant", plantType } };
	}
	return turfFallback();
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npm test -- --grep "PlantCoefficients"`
Expected: PASS (clamp, curve, and dispatcher describes). Run `npm run compile` → clean.

- [ ] **Step 5: Commit.**

```bash
git add routes/adjustmentMethods/PlantCoefficients.ts routes/adjustmentMethods/PlantCoefficients.spec.ts
git commit -m "feat(kc): resolveCropCoefficient precedence dispatcher [#per-plant-kc]"
```

---

## Task 3: Wire the dispatcher into the ETo method

**Files:**
- Modify: `routes/adjustmentMethods/EToAdjustmentMethod.ts`
- Test: `routes/adjustmentMethods/EToCropCoefficient.spec.ts`

- [ ] **Step 1: Write the failing integration test.** Create `routes/adjustmentMethods/EToCropCoefficient.spec.ts`:

```typescript
import * as moment from "moment";
import { expect } from "chai";
import { GeoCoordinates } from "../../types";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import EToAdjustmentMethod, { EToData } from "./EToAdjustmentMethod";

describe( "EToAdjustmentMethod crop-coefficient dispatch", () => {
	const coords: GeoCoordinates = [ 40.0, -105.0 ];
	const periodStartTime = moment.utc( "2024-07-15" ).unix(); // ~ peak day 196

	class StubEToProvider extends WeatherProvider {
		public async getEToData(): Promise< EToData > {
			return {
				weatherProvider: "mock" as any, precip: 0, periodStartTime,
				minTemp: 55, maxTemp: 85, minHumidity: 30, maxHumidity: 70,
				solarRadiation: 6, windSpeed: 5
			};
		}
	}

	it( "applies the customCropCoefficient override to rawData.crop_coefficient", async () => {
		const res: any = await EToAdjustmentMethod.calculateWateringScale(
			{ enableCropCoefficient: true, customCropCoefficient: 0.5 } as any, coords, new StubEToProvider()
		);
		expect( res.rawData.crop_coefficient ).to.equal( 0.5 );
		expect( res.rawData.crop_factors.source ).to.equal( "override" );
	} );

	it( "applies a plant preset's seasonal Kc when plantType is set", async () => {
		const res: any = await EToAdjustmentMethod.calculateWateringScale(
			{ enableCropCoefficient: true, plantType: "vegetable-garden" } as any, coords, new StubEToProvider()
		);
		// vegetable-garden peaks at 1.0 around day 196
		expect( res.rawData.crop_coefficient ).to.be.closeTo( 1.0, 0.05 );
		expect( res.rawData.crop_factors.source ).to.equal( "plant" );
		expect( res.rawData.crop_factors.plantType ).to.equal( "vegetable-garden" );
	} );
} );
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- --grep "crop-coefficient dispatch"`
Expected: FAIL — `crop_factors.source` is `undefined` for the override case (the override is dead code; the turf path runs and produces grass `factors`).

- [ ] **Step 3: Wire the dispatcher.** In `routes/adjustmentMethods/EToAdjustmentMethod.ts`:

  (a) Add the import just below the existing `EnhancedWeatherProvider` import near the top of the file:

```typescript
import { resolveCropCoefficient } from "./PlantCoefficients";
```

  (b) Add the `plantType` field to `EToScalingAdjustmentOptions` (the interface near the bottom of the file that already declares `grassType`, `customCropCoefficient`, etc.). After the `customCropCoefficient` line, add:

```typescript
   /** NEW: Named plant preset selecting a seasonal Kc curve (see PlantCoefficients). */
   plantType?: string;
```

  (c) Replace the crop-coefficient computation inside the `if (enableCropCoefficient) { ... }` block. The current body is:

```typescript
        const avgTemp = (historicalEtoData.maxTemp + historicalEtoData.minTemp) / 2;
        const dayOfYear = moment.unix(historicalEtoData.periodStartTime).dayOfYear();
        
        const kcResult = TurfgrassManager.calculateCropCoefficient(
            grassType,
            grassVariety,
            coordinates,
            usdaZone,
            avgTemp,
            historicalEtoData.precip,
            dayOfYear,
            managementLevel
        );
        
        cropCoefficient = kcResult.kc;
        cropFactors = kcResult.factors;
        
        console.log(`DEBUG: Crop coefficient calculated: ${cropCoefficient}`);
```

  Replace it with (the turf call is preserved verbatim, now wrapped in a thunk passed to the dispatcher):

```typescript
        const avgTemp = (historicalEtoData.maxTemp + historicalEtoData.minTemp) / 2;
        const dayOfYear = moment.unix(historicalEtoData.periodStartTime).dayOfYear();

        const kcResult = resolveCropCoefficient(
            adjustmentOptions,
            dayOfYear,
            () => TurfgrassManager.calculateCropCoefficient(
                grassType,
                grassVariety,
                coordinates,
                usdaZone,
                avgTemp,
                historicalEtoData.precip,
                dayOfYear,
                managementLevel
            )
        );

        cropCoefficient = kcResult.kc;
        cropFactors = kcResult.factors;

        console.log(`DEBUG: Crop coefficient resolved: ${cropCoefficient} (source: ${cropFactors && cropFactors.source})`);
```

  (`adjustmentOptions` is typed `EToScalingAdjustmentOptions` and now carries `customCropCoefficient` + `plantType`, so it satisfies the dispatcher's `opts` parameter.)

- [ ] **Step 4: Run the test + full suite.**

Run: `npm test -- --grep "crop-coefficient dispatch"` → PASS.
Run: `npm test` → all pass. Run `npm run compile` → clean.

- [ ] **Step 5: Commit.**

```bash
git add routes/adjustmentMethods/EToAdjustmentMethod.ts routes/adjustmentMethods/EToCropCoefficient.spec.ts
git commit -m "feat(kc): wire plant-Kc dispatcher into the ETo method (revives customCropCoefficient) [#per-plant-kc]"
```

> **Spec test-coverage mapping:** the dispatcher precedence, curve, and clamp are proven directly in Tasks 1-2. Task 3 proves the *wiring*: that `EToAdjustmentMethod` routes through `resolveCropCoefficient` so the override and plant presets actually reach `rawData.crop_coefficient`/`crop_factors`. The turf-preserved path is covered because the dispatcher invokes the unchanged `TurfgrassManager` thunk whenever no override/plantType is set (Task 2's "uses the turf fallback" test + the full suite staying green).

---

## Task 4: User documentation

**Files:**
- Create: `docs/per-plant-kc.md`
- Modify: `README.md`

- [ ] **Step 1: Write the docs.** Create `docs/per-plant-kc.md`:

```markdown
# Per-plant Crop Coefficient (Kc)

The **ETo** watering method (adjustment method 3) scales watering by a crop coefficient
(Kc). By default it uses turfgrass coefficients. You can instead pick a **plant preset**
(for beds, shrubs, trees, a vegetable garden, etc.) or supply an **explicit Kc override**.

This applies to the ETo method only. (The Water-Budget method does not use Kc yet.)

## Selecting a coefficient

Resolution order (first match wins):

1. **Explicit override** — `customCropCoefficient` (`wto`) or `CUSTOM_CROP_COEFFICIENT` (env):
   a single Kc value, clamped to 0.1–1.5. Non-numeric values are ignored.
2. **Plant preset** — `plantType` (`wto`) or `PLANT_TYPE` (env): a named preset with a
   seasonal curve (lower in winter, peaking in mid-summer).
3. **Turfgrass** — the existing `grassType` / `usdaZone` / `managementLevel` behavior.

The master switch `enableCropCoefficient` (`wto`) / `ENABLE_CROP_COEFFICIENT` (env, default on)
still applies: when off, Kc is fixed at 1.0 and neither preset nor override is used.

## Plant presets

| `plantType` | Winter Kc | Summer Kc |
|---|---|---|
| `trees` | 0.40 | 0.65 |
| `shrubs` | 0.30 | 0.50 |
| `groundcover` | 0.30 | 0.50 |
| `perennials` | 0.20 | 0.50 |
| `annual-flowers` | 0.20 | 0.80 |
| `vegetable-garden` | 0.30 | 1.00 |
| `native` | 0.15 | 0.30 |

Values are approximate (FAO-56 / WUCOLS landscape coefficients) and interpolate smoothly by
day-of-year, peaking around mid-July (Northern hemisphere). An unrecognized `plantType` falls
back to the turfgrass calculation. The chosen source appears in the response as
`rawData.crop_factors.source` (`override`, `plant`, or the turfgrass factors), and the resolved
value as `rawData.crop_coefficient` (legacy `kc`).
```

  Add this line to `README.md` near the other docs links (after the weather-skips / fallback links):

```markdown
- For **per-plant crop coefficients** (plant presets or an explicit Kc for the ETo method), see [here](docs/per-plant-kc.md)
```

- [ ] **Step 2: Verify + commit.**

Run: `npm run compile` (clean) and confirm both files are staged.

```bash
git add docs/per-plant-kc.md README.md
git commit -m "docs(kc): per-plant crop coefficient user guide [#per-plant-kc]"
```

---

## Done criteria

- `npm test` green (existing suite + new `PlantCoefficients` clamp/curve/dispatcher tests + the ETo dispatch integration tests), `npm run compile` clean.
- With no `plantType` / `customCropCoefficient` set, the ETo method behaves **identically** to before (the dispatcher invokes the unchanged `TurfgrassManager` thunk).
- Setting `customCropCoefficient` applies a clamped explicit Kc; setting a known `plantType` applies its seasonal curve; both surface via `rawData.crop_coefficient` + `rawData.crop_factors.source`.
- `TurfgrassManager` is unmodified.

## Out of scope (per spec)
- Water-Budget Kc (`ETc = ETo × Kc` in method 4) — deferred to a migration-aware follow-up plan.
- Southern-hemisphere curve shifting; WUCOLS sub-factors; FAO growth-stage models; per-zone/multi-scale output; restructuring `TurfgrassManager`.
