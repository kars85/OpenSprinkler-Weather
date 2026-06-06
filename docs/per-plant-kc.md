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
