# Per-plant Kc — Design Spec

**Date:** 2026-06-05
**Status:** Approved for planning (pending user read-through)
**Feature:** A crop-coefficient (Kc) override plus a catalog of named plant presets — each a seasonal day-of-year Kc curve — wired into the ETo adjustment method via a small dispatcher, alongside (not replacing) the existing turfgrass engine.

---

## 1. Problem & Goal

The ETo method (adjustment method 3) already scales watering by a crop coefficient, but the machinery is **turfgrass-only**: `TurfgrassManager.calculateCropCoefficient` handles `GrassType` (cool-/warm-season/native/mixed/custom) and nothing else. Two gaps:

1. A user whose controller waters **non-turf** plants (shrubs, trees, groundcover, a vegetable garden, native/xeric beds) has no correct Kc — they're stuck with grass coefficients.
2. `EToScalingAdjustmentOptions.customCropCoefficient` is **declared but never consumed** (`EToAdjustmentMethod.ts:830` / the `enableCropCoefficient` block at `:337-356`) — a dead override.

**Goal:** add named plant presets (each a Northern-hemisphere day-of-year seasonal Kc curve) and make the `customCropCoefficient` override real, selected through a single **precedence dispatcher**, all within the ETo method. Preserve the existing turfgrass behavior exactly.

**Scope decision (4-way `/octo:debate`, unanimous Option C):** ETo method **only**. Water-Budget (method 4) is explicitly **out of scope** — adding `ETc = ETo × Kc` there changes the meaning of the *persisted* rain-bank (ETo-based → ETc-based), needs a migration/reset policy, and adds a NaN-multiplicand risk to a fail-open state store. That becomes its own migration-aware follow-up plan. ETo has no persisted state, so the same change there is safe and reversible.

---

## 2. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| D1 | **Method scope** | ETo (method 3) only. Water-Budget deferred to a follow-up. |
| D2 | **Architecture** | A `resolveCropCoefficient` **dispatcher** (precedence below). The existing `TurfgrassManager` is the grass branch, **untouched**, injected as a thunk. No parallel Kc engine. |
| D3 | **Preset model** | Per-plant **day-of-year seasonal Kc curve** (cosine between a dormant-season floor and a summer peak), Northern-hemisphere only. |
| D4 | **Override** | `customCropCoefficient` consumed as a **clamped, finite** override (revives dead code). |
| D5 | **Selection** | `wto` options (`plantType`, `customCropCoefficient`) and env (`PLANT_TYPE`, `CUSTOM_CROP_COEFFICIENT`), mirroring the existing grass/zone option pattern. |

---

## 3. Architecture — dispatcher + standalone catalog

New module: `routes/adjustmentMethods/PlantCoefficients.ts` (pure, no dependency on `TurfgrassManager` — the turf branch is injected, avoiding an import cycle).

It exports:
- `PlantType` — union of preset keys.
- `PLANT_KC_CATALOG` — preset data (each: `{ dormantKc, peakKc, peakDay?, }`).
- `getPlantKc(plantType, dayOfYear): number` — the seasonal curve.
- `clampKc(value): number | undefined` — finite-and-clamped, else `undefined`.
- `resolveCropCoefficient(opts, dayOfYear, turfFallback): { kc, factors }` — the precedence dispatcher.

**Precedence** (highest first):

```
resolveCropCoefficient(opts, dayOfYear, turfFallback):
  1. clampKc(opts.customCropCoefficient ?? env CUSTOM_CROP_COEFFICIENT) defined
        → { kc, factors: { source: "override" } }
  2. plantType = opts.plantType ?? env PLANT_TYPE, and PLANT_KC_CATALOG[plantType] exists
        → { kc: getPlantKc(plantType, dayOfYear), factors: { source: "plant", plantType } }
  3. otherwise
        → turfFallback()        // existing TurfgrassManager path, unchanged
```

`EToAdjustmentMethod` calls `resolveCropCoefficient(opts, dayOfYear, () => TurfgrassManager.calculateCropCoefficient(...))` inside the existing `if (enableCropCoefficient)` block, replacing the direct `TurfgrassManager` call. When crop coefficient is disabled, Kc stays `1.0` as today (override/preset only take effect when enabled — consistent with current behavior).

**Why a thunk for turf:** keeps `PlantCoefficients.ts` free of any `TurfgrassManager`/`EToAdjustmentMethod` import (no cycle — see the fallback-feature cycle we just hit), and makes the dispatcher unit-testable with a mock turf fallback.

---

## 4. Seasonal curve model

`getPlantKc` interpolates between a winter floor and a summer peak with a cosine (smooth, no piecewise, peak at `peakDay`):

```
phase = ((dayOfYear - peakDay) / 365) * 2π
kc    = dormantKc + (peakKc - dormantKc) * (1 + cos(phase)) / 2
```

- At `dayOfYear == peakDay` → `peakKc`; half a year away → `dormantKc`; smooth between.
- `peakDay` default **196** (~Jul 15, Northern-hemisphere mid-summer). Evergreen plants carry a higher `dormantKc`; deciduous/annual a lower one.
- Result is rounded to 2 decimals and is always within `[dormantKc, peakKc]` ⊆ the global clamp.

**Initial catalog** (approximate FAO-56 / WUCOLS landscape values; documented as adjustable):

| `plantType` | dormantKc | peakKc | Notes |
|---|---|---|---|
| `trees` | 0.40 | 0.65 | mixed broadleaf/evergreen |
| `shrubs` | 0.30 | 0.50 | moderate-water ornamental |
| `groundcover` | 0.30 | 0.50 | |
| `perennials` | 0.20 | 0.50 | herbaceous beds |
| `annual-flowers` | 0.20 | 0.80 | seasonal color |
| `vegetable-garden` | 0.30 | 1.00 | mid-season vegetables |
| `native` | 0.15 | 0.30 | established native/xeric |

All values sit within the §5 global clamp. Unknown `plantType` strings fall through to the turf branch (never throw).

---

## 5. Override clamp & guards

`clampKc(value)`:
- Coerce to number; if **non-finite** → `undefined` (dispatcher falls through to the next precedence tier — a junk override never silently zeroes watering).
- Else clamp to `[KC_MIN, KC_MAX] = [0.1, 1.5]` and return. (Landscape Kc realistically spans ~0.15–1.2; the bounds prevent absurd inputs from over-/under-watering.)

This mirrors the project's existing NaN-safety posture (Water-Budget fail-open, skips fail-open): bad numeric input degrades to the next sensible source, never to a corrupt scale.

---

## 6. Options, env, and response

**Types** (`EToScalingAdjustmentOptions`, `EToAdjustmentMethod.ts`): add `plantType?: PlantType | string;`. `customCropCoefficient?: number` already exists (now consumed).

**Selection** (mirrors existing grass/zone resolution at `:316-320`):
- `plantType`: `adjustmentOptions.plantType ?? process.env.PLANT_TYPE`.
- `customCropCoefficient`: `adjustmentOptions.customCropCoefficient ?? Number(process.env.CUSTOM_CROP_COEFFICIENT)`.

**Response:** the ETo path already emits `crop_coefficient` (→ legacy `kc`) and `crop_factors`. The dispatcher's `factors` (e.g. `{ source: "plant", plantType: "shrubs" }` or `{ source: "override" }`) flows into `crop_factors` so the chosen Kc source is visible. No new response field is required; no wire-format change.

---

## 7. Affected files

| File | Change |
|------|--------|
| `routes/adjustmentMethods/PlantCoefficients.ts` | **New.** `PlantType`, `PLANT_KC_CATALOG`, `getPlantKc`, `clampKc`, `resolveCropCoefficient`. |
| `routes/adjustmentMethods/PlantCoefficients.spec.ts` | **New.** Pure unit tests (curve, clamp, dispatcher precedence with a mock turf fallback). |
| `routes/adjustmentMethods/EToAdjustmentMethod.ts` | Add `plantType` to `EToScalingAdjustmentOptions`; resolve `plantType`; replace the direct `TurfgrassManager.calculateCropCoefficient(...)` call inside the `enableCropCoefficient` block with `resolveCropCoefficient(opts, dayOfYear, () => TurfgrassManager.calculateCropCoefficient(...))`. |
| `docs/per-plant-kc.md` + `README` | **New/updated.** User guide: plant presets, override, env/`wto` options. |

`TurfgrassManager` itself is **not modified**.

---

## 8. Testing strategy

Pure unit tests, no network:
- **`getPlantKc`:** equals `peakKc` at `peakDay`; equals `dormantKc` ~182 days away; monotonic on each side; every catalog entry stays within `[dormantKc, peakKc]` and within `[0.1, 1.5]`.
- **`clampKc`:** finite in-range returns as-is; out-of-range clamps to the bound; `NaN`/`undefined`/non-numeric → `undefined`.
- **`resolveCropCoefficient` precedence:** override wins over plant and turf; a junk override (`NaN`) falls through to plant; a known `plantType` wins over turf; unknown `plantType` → turf fallback invoked; no override + no plantType → turf fallback invoked.
- **Consistency:** with no `plantType`/override set, the dispatcher calls the turf fallback exactly once and returns its result unchanged (proves grass behavior is preserved).

(The heavy `calculateWateringScale` integration is unchanged in shape; the dispatcher is the new logic and is fully covered in isolation — same pattern the fallback/skip features used.)

---

## 9. Out of scope
- **Water-Budget Kc** (`ETc = ETo × Kc` in method 4) — deferred to a dedicated, migration-aware follow-up plan that owns the ETo→ETc bank-semantics change, a reset/migration policy, and NaN/0 guards on the multiplicand.
- Southern-hemisphere curve shifting (curves are Northern-only, matching existing turf behavior).
- WUCOLS density/microclimate sub-factors; FAO growth-stage / planting-date models; per-zone/multi-scale output (the protocol returns one scale).
- Modifying or restructuring `TurfgrassManager`.

---

## 10. Configuration summary

| Setting | Type | Default | Effect |
|---|---|---|---|
| `plantType` (`wto`) / `PLANT_TYPE` (env) | string | unset | Selects a plant preset's seasonal Kc curve. Unknown ⇒ falls through to grass. |
| `customCropCoefficient` (`wto`) / `CUSTOM_CROP_COEFFICIENT` (env) | number | unset | Explicit Kc override (clamped 0.1–1.5; non-finite ignored). Highest precedence. |
| `enableCropCoefficient` (`wto`) / `ENABLE_CROP_COEFFICIENT` (env) | bool | on | Master gate (existing). When off, Kc = 1.0 and neither preset nor override applies. |
| existing `grassType` / `usdaZone` / `managementLevel` | — | unchanged | Used by the turf fallback when no preset/override is set. |
