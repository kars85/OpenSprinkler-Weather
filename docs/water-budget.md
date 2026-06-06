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
