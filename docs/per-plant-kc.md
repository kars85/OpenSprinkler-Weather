# Per-plant Crop Coefficient (Kc)

The **ETo** watering method (adjustment method 3) scales watering by a crop coefficient
(Kc). By default it uses turfgrass coefficients. You can instead pick a **plant preset**
(for beds, shrubs, trees, a vegetable garden, etc.) or supply an **explicit Kc override**.

The ETo method uses `PLANT_TYPE` / `CUSTOM_CROP_COEFFICIENT`; the Water-Budget method uses separate `BUDGET_` settings described below.

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

## Water-Budget method

The Water-Budget method (adjustment method 4) also supports these plant presets, but via
its own settings — `BUDGET_PLANT_TYPE` and `BUDGET_CUSTOM_CROP_COEFFICIENT`
(not the `PLANT_TYPE` / `CUSTOM_CROP_COEFFICIENT` used by the ETo method). The preset
catalog and seasonal curves are identical. See the Water-Budget guide for details.

### Per-request Water-Budget Kc

Water-Budget also accepts a per-request `budgetKc` query option for adjustment method 4.
It overrides the Water-Budget Kc for that request only; when it is absent or invalid, the
method falls back to `BUDGET_CUSTOM_CROP_COEFFICIENT`, then `BUDGET_PLANT_TYPE`, then
`BUDGET_KC` as the budget reference. `budgetKc` uses the same `clampKc` validation bounds
as other Kc overrides (`KC_MIN` 0.1, `KC_MAX` 1.5). Non-numeric or otherwise junk values
are ignored and fall back to the configured defaults.

The override is applied only when the Water-Budget model advances for a new local day. On
the first advancing poll, `budgetKc` flows into ETc and depletion and is reported with
`kcSource: "override-budget"`. On a same-day re-poll, the day is locked: the cached scale
is returned, there is no recompute and no persisted pending override, and the response
reports `budgetKcApplied: false`.
