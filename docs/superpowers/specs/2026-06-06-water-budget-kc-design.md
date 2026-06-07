# Water-Budget per-plant Kc — Design Spec

**Date:** 2026-06-06
**Status:** Approved for planning (pending user read-through)
**Feature:** Make the Water-Budget method (adjustment method 4) use the per-plant crop coefficient (the `PlantCoefficients` module from the ETo feature) for **demand**, asymmetrically against an unchanged **reference**, so plant choice actually scales watering. Env-only config, continuity-preserving, no state migration.

---

## 1. Problem

Water-Budget already applies a crop coefficient, but it's a single env value (`BUDGET_KC`, default 0.9) applied to **both** demand and reference in `SoilMoistureModel.step` (`SoilMoistureModel.ts:95-96`):

```
etc          = max(0, fin(eto))       × kc
referenceEtc = max(0, fin(referenceEto)) × kc
scale        = clamp( round(100 × unmetDemand / referenceEtc), 0, maxScale )
```

On a dry day with no rain memory, `unmetDemand = etc` and `scale = 100 × (eto·kc)/(referenceEto·kc)` — **`kc` cancels**. So today, plant/seasonal kc would have *no effect* on the dominant dry-day scale; it would only shift rain-bank dynamics and the bank cap. Water-Budget is a *relative* adjuster ("water X% of normal"), so a symmetric kc is invisible in the main case.

## 2. Approach (decided)

**Asymmetric kc:** demand uses the resolved per-plant/seasonal kc; reference stays on the existing baseline.

```
etc          = max(0, fin(eto))       × demandKc       // per-plant / seasonal (or override)
referenceEtc = max(0, fin(referenceEto)) × referenceKc    // = BUDGET_KC, unchanged role
scale (dry)  = 100 × eto·demandKc / (referenceEto·referenceKc)
```

Now plant choice scales watering: a vegetable garden (`demandKc ≈ 1.0`) waters near the full relative ratio; a native/xeric planting (`demandKc ≈ 0.3`) waters at ~30% of it.

## 3. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| D1 | **Model** | Split `kc` into demand (`params.kc`) and `referenceKc`. `referenceKc = BUDGET_KC`. |
| D2 | **Demand kc source** | `resolveCropCoefficient` (from `PlantCoefficients.ts`), demand = plant preset / override / default. |
| D3 | **Config surface** | **Env-only** (per the v1 once-per-day idempotency decision, `WaterBudgetAdjustmentMethod.ts:30-33`). |
| D4 | **Env namespace** | Water-Budget-specific: `BUDGET_PLANT_TYPE`, `BUDGET_CUSTOM_CROP_COEFFICIENT` — **not** the shared `PLANT_TYPE`/`CUSTOM_CROP_COEFFICIENT` (avoids coupling the ETo and Water-Budget methods through one env var). |
| D5 | **Continuity** | Default `demandKc = BUDGET_KC` when unconfigured → cancels → same scale/state as today. No state migration. |
| D6 | **Observability** | `kc` + `kcSource` added to Water-Budget rawData **conditionally** (only when a plant/override is active), persisted in `DecisionRecord`, and forwarded through legacy conversion. |

## 4. Continuity & migration

- `referenceKc = BUDGET_KC`: the reference (which sets scale normalization *and* `rainBankCap = rainBankCapDays × referenceEtc`) is **unchanged**. `BUDGET_KC`'s documented role becomes "reference/normal crop coefficient."
- When `BUDGET_PLANT_TYPE`/`BUDGET_CUSTOM_CROP_COEFFICIENT` are unset, `demandKc` resolves to `BUDGET_KC` → `demandKc === referenceKc` → kc cancels → **same scale and same persisted state** as today. Combined with conditional metadata (§7), the response is unchanged too.
- **No state migration / reset.** `BudgetState.rainBank` is inches of effective-rain inventory (plant-agnostic); the schema is unchanged.
- **Carry-forward, not historical equivalence (intentional):** when a plant is enabled later, the model reuses the *existing* `rainBank` balance, which was drained under the old `BUDGET_KC` demand (`SoilMoistureModel.ts:113`). This can create a brief transient versus a model that had *always* used the plant kc. This is accepted carry-forward behavior, documented for users — not a bug, and not worth a reset.

## 5. Model change — `SoilMoistureModel`

- `BudgetParams` gains `referenceKc: number`. The existing `kc` field is now the **demand** coefficient (semantic change; same field).
- `StepInput` gains `kcSource?: string` (metadata to persist; does not affect math).
- In `step()`:
  ```
  etc          = Math.max(0, fin(eto))       * fin(params.kc);          // demand
  referenceEtc = Math.max(0, fin(referenceEto)) * fin(params.referenceKc); // reference
  ```
  Wrap both kc multiplicands in `fin(...)` (the existing NaN-coercion helper) so a non-finite kc can never poison `etc`/`referenceEtc`/the persisted bank — extending the model's existing fail-safe posture. (`fin(NaN) → 0`; a 0 demand kc yields scale 0, but §6 guarantees a finite positive kc before this point, so `fin` here is pure defense-in-depth.)
- `DecisionRecord` gains optional `demandKc?: number` and `kcSource?: string`; `step()` records `demandKc = round2(params.kc)` and `kcSource = input.kcSource`. (Optional ⇒ pre-existing persisted history stays valid.)

## 6. Demand-kc resolution — `WaterBudgetAdjustmentMethod`

After `etoData` is fetched and validated (finite `eto`/`precip`), and **only on the day's first advance** (the same-day branch returns early at `:123-132`):

```ts
const referenceKc = envNum( "BUDGET_KC", 0.9 );           // reference baseline (was `kc`)
const dayOfYear = moment.unix( etoData.periodStartTime )
                       .tz( geoTZ( coordinates[0], coordinates[1] )[0] ).dayOfYear(); // site tz, matches localDateString
const kcEnv = { PLANT_TYPE: process.env.BUDGET_PLANT_TYPE,
                CUSTOM_CROP_COEFFICIENT: process.env.BUDGET_CUSTOM_CROP_COEFFICIENT };
const resolved = resolveCropCoefficient(
    {},                                                   // empty wto → env-only
    dayOfYear,
    () => ( { kc: referenceKc, factors: { source: "budget" } } ), // turf-less fallback = reference
    kcEnv                                                 // Water-Budget-specific env namespace
);
let demandKc = resolved.kc;
if ( !Number.isFinite( demandKc ) || demandKc <= 0 ) demandKc = referenceKc; // NaN/zero guard
const kcSource = resolved.factors && resolved.factors.source;                 // "plant" | "override" | "budget"
```

Then `step()` is called with `params.kc = demandKc`, `params.referenceKc = referenceKc`, and `input.kcSource = kcSource`.

- `{}` empty wto ⇒ the dispatcher reads only the injected `kcEnv` (Water-Budget's own vars), honoring the **env-only** v1 stance and the §3 D4 namespace decision.
- Day-of-year is computed in the **site timezone** (consistent with `localDateString`, `:45`). Note: the ETo path computes `dayOfYear` without timezone (`EToAdjustmentMethod.ts:339`); that inconsistency is pre-existing and out of scope here.
- `resolveCropCoefficient`/`PlantCoefficients` are **reused unchanged** — no catalog or dispatcher edits.

## 7. Observability & legacy path

- **rawData (conditional):** add `kc` and `kcSource` to the Water-Budget rawData **only when `kcSource && kcSource !== "budget"`** (i.e. a plant preset or override is actually in effect). When unconfigured, the rawData shape is unchanged → continuity. Apply this in **both** rawData builders: `buildRawDataFromDecision` (same-day + post-step record path) and the cold-start fallback object (`WaterBudgetAdjustmentMethod.ts:151-159`).
- **Persistence:** because same-day re-polls rebuild rawData from the stored `DecisionRecord` (`:123-132`), `demandKc`/`kcSource` are read from the record (§5) — so same-day responses report the *same* coefficient that produced the stored scale, never a recomputed-from-current-env value.
- **Legacy conversion:** extend the WaterBudget branch of `convertToLegacyFormat` (`weather.ts:133-138`, currently `eto/etc/p/bank/reason`) to also forward `kc` and `kcSource` when present, so legacy/simplified responses don't drop the new fields.
- **Stale-hold responses unchanged (intentional):** the fail-open "hold last value" paths (weather unavailable `:95-100`, incomplete weather `:113-118`) return a simple rawData (`wp/scale/reason`) and do **not** go through `buildRawDataFromDecision`. Active-coefficient metadata is reported **only** for model-decision responses (built from a `DecisionRecord` / the post-step result); stale-hold responses remain as-is, with no `kc`/`kcSource`. This is intended — a held value did not run the model this request, so it has no live coefficient to report.

## 8. Affected files

| File | Change |
|------|--------|
| `routes/adjustmentMethods/SoilMoistureModel.ts` | `BudgetParams.referenceKc`; `StepInput.kcSource`; asymmetric `etc`/`referenceEtc` with `fin()` guards; record `demandKc`/`kcSource` in `DecisionRecord`. |
| `routes/adjustmentMethods/WaterBudgetAdjustmentMethod.ts` | Resolve `demandKc` via `resolveCropCoefficient` (env-only, `BUDGET_`-namespaced) with NaN/zero guard + site-tz `dayOfYear`; pass `referenceKc`/`kc`/`kcSource` to `step`; conditional `kc`/`kcSource` in both rawData builders; `resolveParams` adds `referenceKc`. |
| `routes/weather.ts` | `convertToLegacyFormat` WaterBudget branch forwards `kc`/`kcSource` when present. |
| `routes/adjustmentMethods/SoilMoistureModel.spec.ts` | Asymmetric-kc unit tests (demand≠reference scales dry-day scale; demand==reference reproduces current numbers; non-finite kc → safe). |
| `routes/adjustmentMethods/WaterBudgetKc.spec.ts` | **New.** Method-level: `BUDGET_PLANT_TYPE` changes scale vs default; unset ⇒ unchanged scale + no `kc`/`kcSource` in rawData; non-finite override falls back to `referenceKc`. |
| `docs/water-budget.md` + `docs/per-plant-kc.md` | Document Water-Budget Kc: `BUDGET_PLANT_TYPE`/`BUDGET_CUSTOM_CROP_COEFFICIENT`, asymmetric model, carry-forward note. |

`PlantCoefficients.ts` and the ETo method are **not** modified.

## 9. Testing strategy

Pure/where possible:
- **`step` asymmetric:** with `kc=1.0, referenceKc=0.9`, dry-day scale = `round(100·eto·1.0/(refEto·0.9))` (demand kc now affects scale); with `kc==referenceKc`, scale/state match the pre-change formula exactly (continuity); `kc=NaN` ⇒ `fin` coerces to 0, no NaN in state.
- **`step` records metadata:** `demandKc`/`kcSource` land in the `DecisionRecord`.
- **Method-level:** `BUDGET_PLANT_TYPE="native"` yields a lower scale than unset (default `BUDGET_KC`) for the same weather; unset ⇒ rawData has no `kc`/`kcSource`; with **`BUDGET_PLANT_TYPE` unset**, `BUDGET_CUSTOM_CROP_COEFFICIENT="abc"` (non-finite) falls back to `referenceKc` (the dispatcher ignores the bad override, then — because no plant is set — uses the budget fallback); same-day re-poll returns the stored `kc`/`kcSource` from history.
- **Legacy:** `convertToLegacyFormat` forwards `kc`/`kcSource` for the WaterBudget method when present.

## 10. Out of scope

- Per-request (`wto`) Water-Budget kc (env-only by D3).
- A separate reference-kc env var (reuse `BUDGET_KC`).
- Changes to the ETo path, the `PlantCoefficients` catalog/dispatcher, or the ETo `dayOfYear` tz inconsistency.
- Any `BudgetState` schema migration/reset (none needed).

## 11. Configuration summary

| Setting | Type | Default | Effect |
|---|---|---|---|
| `BUDGET_PLANT_TYPE` | env | unset | Selects a plant preset's seasonal **demand** Kc curve for Water-Budget. Unknown ⇒ falls back to `BUDGET_KC`. |
| `BUDGET_CUSTOM_CROP_COEFFICIENT` | env (number) | unset | Explicit demand Kc override (clamped 0.1–1.5; non-finite ignored). Highest precedence. |
| `BUDGET_KC` | env (number) | 0.9 | Now the **reference/normal** crop coefficient (normalization + bank cap) and the default demand kc when nothing else is set. Unchanged default ⇒ unchanged behavior. |
