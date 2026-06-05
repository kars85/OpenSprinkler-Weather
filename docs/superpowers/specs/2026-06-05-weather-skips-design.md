# Weather Skips (Freeze / Wind / Rain) — Design Spec

- **Date:** 2026-06-05
- **Status:** Approved (brainstorming) — ready for implementation planning
- **Component:** OpenSprinkler-Weather (TypeScript / Express weather → watering-scale service)
- **Relation:** Cross-cutting guard layer; complements the existing adjustment methods (Manual / Zimmerman / RainDelay / ETo / WaterBudget). Independent of the water-budget feature.

## Problem & Goal

The service computes a watering `scale %` per request, but it never suppresses watering for three common conditions that waste water or risk damage:

- **Freeze** — watering at/below freezing is ineffective and can damage pipes/heads.
- **Wind** — watering in high wind wastes water to evaporation and drift.
- **Rain** — when today's weather already reports meaningful precipitation, watering is redundant.

This feature adds three opt-in **skip guards** that force `scale = 0` when their condition is met. They are **cross-cutting**: one guard layer applies identically to every adjustment method, so no method needs to learn freeze/wind/rain policy.

## Design Decisions (resolved in brainstorming)

| Topic | Decision |
|---|---|
| Placement | A **pure `evaluateSkips()`** function + a **guard step in `getWateringData`**, not a wrapper method and not per-method duplication. |
| Data source | One `getWeatherData()` call in the guard layer (returns `minTemp`/`temp`/`wind`/`precip`), applied uniformly across all methods. |
| Defaults | **All opt-in (default OFF).** Zero behavior change until a user enables a skip. |
| Caching | The watering-scale cache **and the existing California restriction behavior are unchanged** (the cache still holds the method+restriction result). Weather skips are a **live per-request overlay** applied *after* cache-hit/miss resolution, with a separate **short-TTL memoized** weather fetch — live guards, not daily decisions. Restructuring the restriction to be live is a separate follow-up (out of scope). |
| Failure mode | **Fail-open**, per rule. Never block watering on absent/uncertain data. |
| Skip effect | Hard `scale = 0` (v1). Not a reduction. |

## Architecture & Components

Two units:

1. **`routes/skips/WeatherSkips.ts`** — a **pure** function `evaluateSkips(weather, cfg)` plus the config/type definitions. No I/O. The risky policy logic, isolated and fully unit-testable (mirrors `SoilMoistureModel`).
2. **A guard step inside `routes/weather.ts` `getWateringData`** — resolves the method scale (from cache or fresh), runs the existing restriction check, then runs the skip guard (fetch weather fail-open → `evaluateSkips` → maybe `scale = 0`), then sends. Plus a small **skip-weather memo** (module-level, separate from `WateringScaleCache`) and a **universal passthrough** in `convertToLegacyFormat`.

```
method scale (cache OR fresh)        <- cached daily, unchanged
        |
existing California restriction      <- runs first, unchanged
        |   (only if >= 1 skip enabled)
fetchSkipWeather(provider, coords, pws)   <- short-TTL memo, fail-open
        |
evaluateSkips(weather, cfg)
        |   skip? -> build fresh response with scale = 0, rawData.skip = 1, rawData.skipReason
convertToLegacyFormat (preserves skip/skipReason)  -> send
```

## The Skip Logic (`evaluateSkips`)

```
evaluateSkips(
  w: { minTemp?: number; temp?: number; wind?: number; precip?: number },
  cfg: { freeze?: { temp: number }; wind?: { max: number }; rain?: { threshold: number } }
): { skip: boolean; reason?: string }
```

- Only **enabled** rules are present in `cfg`. Rules are evaluated in **safety order** (freeze -> wind -> rain); the **first trigger wins**.
- **Per-rule fail-open:** each rule no-ops if its required field is missing/non-finite; other rules still evaluate. A missing field never disables all skips.
- **Boundaries are inclusive:**

| Rule | Field(s) | Triggers when | Reason (ASCII) |
|---|---|---|---|
| Freeze | `minTemp ?? temp` | `t <= cfg.freeze.temp` | `"freeze: 28F at or below 32F"` |
| Wind | `wind` | `wind >= cfg.wind.max` | `"wind: 27mph at or above 25mph"` |
| Rain | `precip` | `precip >= cfg.rain.threshold` | `"rain: 0.3in at or above 0.1in"` |

- **Local/PWS freeze fallback:** `local.getWeatherData()` returns `minTemp: undefined`, so freeze uses `minTemp ?? temp` (the current temperature) to remain effective for Ecowitt/local.
- **Rain semantics (explicit):** rain-skip uses `getWeatherData().precip` — **today's reported/forecast precipitation for the provider's current window, not a live "is it raining now" sensor.** The firmware's own rain sensor owns sub-hour reactivity. This guard means "today already looks wet enough."
- **Reason format:** ASCII words only — no `=`, `<`, `>`, or quotes. This is a *conservative* rule (not strictly required, since `rawData` is JSON-stringified as a single legacy value), but it keeps the legacy querystring unambiguous and the worded phrasing ("at or below") is clearer anyway.

## Caching & Live Evaluation

- **Existing method-cache and restriction behavior are unchanged.** `WateringScaleCache` continues to store the adjustment-method result *including the current California restriction* (the restriction still runs on the original cache miss only, using its current data source). This feature does **not** refactor the cache or the restriction.
- Weather skips are applied as a **live, per-request overlay AFTER cache-hit/miss resolution**, so they are genuinely live regardless of the cache: a morning no-skip does not suppress an evening freeze, and a morning skip does not pin `scale = 0` after conditions clear.
- The skip overlay **always builds a fresh response object** (`{ ...dataToSend, scale: 0, rawData: { ...rawData, skip: 1, skipReason } }`) and **never mutates the cached object** by reference.
- If the resolved (possibly cached) result is already `scale = 0` (e.g. the restriction fired on the original miss), skip evaluation may still run, but it **only adds `skip`/`skipReason` when a skip actually triggers** — it never invents metadata on top of a pre-existing 0.
- To bound provider load under frequent polling, the skip's `getWeatherData` fetch is memoized with a short TTL (`SKIP_WEATHER_TTL`, default 600000 ms / 10 min).

## Skip-Weather Memo

A module-level `Map`, **separate from `WateringScaleCache`** (different TTL and semantics). Key prevents cross-poisoning between providers/locations/stations:

```
key = `${ process.env.WEATHER_PROVIDER === 'local' ? 'local' : 'remote' }`
    + `|${ weatherProvider.constructor.name }|${ adjustmentOptions.provider || '' }`
    + `|${ lat.toFixed(4) },${ lon.toFixed(4) }`
    + `|${ pws ? ( pws.id || 'pwskey' ) : 'nopws' }`
```

`fetchSkipWeather()` returns a fresh memo entry if unexpired, else performs **one** `getWeatherData` call. On throw or unusable result it returns `undefined` and **does not memoize the failure**.

**Documented caveat:** two *key-only* PWS requests (no `pws.id`) at the same coordinates share a `pwskey` memo entry — i.e. they reuse the same skip-weather. This is acceptable (and privacy-preserving — the API key is not part of the key); noted so it is not surprising.

## Configuration

Environment defaults, overridable per request via `wto`. Skips are stateless, so per-request overrides are safe. **Enabling a rule is separate from its threshold** — a threshold value never enables a rule on its own.

| Setting | env (enable) | env (value) | `wto` enable | `wto` value | default |
|---|---|---|---|---|---|
| Freeze | `SKIP_FREEZE` | `FREEZE_TEMP` | `skipFreeze` | `skipFreezeTemp` | off / 32 (F) |
| Wind | `SKIP_WIND` | `WIND_MAX` | `skipWind` | `skipWindMax` | off / 25 (mph) |
| Rain | `SKIP_RAIN` | `RAIN_SKIP` | `skipRain` | `skipRainThreshold` | off / 0.1 (in) |
| Weather memo TTL | `SKIP_WEATHER_TTL` | — | — | — | 600000 ms |

`wto` keys are deliberately specific (`skipFreeze`, `skipFreezeTemp`, ...) to avoid collision with existing watering/provider options (which already use generic keys). `resolveSkipConfig(adjustmentOptions)` returns a config containing only the enabled rules.

**Strict boolean parsing.** Enable flags (`SKIP_FREEZE`/`skipFreeze`, etc.) are parsed with an explicit allow-list: only the tokens `true`, `1`, `yes`, `on` (case-insensitive) enable a rule. **Any other value — including an arbitrary non-empty string — leaves the rule off.** (This avoids the common bug where any present env var enables a feature.) Thresholds are parsed as finite numbers and are only consulted when their rule is enabled.

## Pipeline Placement & Restriction Interaction

The skip overlay is appended **after** the existing `getWateringData` flow, which is otherwise unchanged:

1. **Existing, unchanged:** resolve the method result — a cache hit returns the cached value; a cache miss runs the method, then the California restriction (on the miss path, using its current `getWateringData`/method `wateringData` precip), then stores the result. The restriction remains cached as today.
2. **New skip overlay (this feature):** after the result is resolved, if `>= 1` skip is enabled, fetch skip weather (memoized, fail-open) and run `evaluateSkips`. On a trigger, build a **fresh** response with `scale = 0`, `rawData.skip = 1`, `rawData.skipReason`. If no rule fires, leave the resolved result untouched — never clobber a restriction-induced `0`, never invent `skip`/`skipReason`.
3. The overlay never mutates or re-caches anything; it is purely additive and per-request.

## Legacy Response Survival

`convertToLegacyFormat` reduces `rawData` to method-specific fields for non-ETo/non-Zimmerman methods. Because skips are cross-cutting, the converter gets a **universal passthrough**: when `rawData.skip` / `rawData.skipReason` are present, copy them through for **every** adjustment method (outside the method-specific branches). Combined with ASCII-only reasons, the skipped response round-trips through both the JSON and legacy querystring encoders intact.

## Error Handling — fail-open everywhere

- `getWeatherData` throws or returns nothing -> **no skip evaluated** (watering proceeds with the method scale). Failures are not memoized.
- A required field is missing/non-finite -> only **that** rule no-ops; other enabled rules still evaluate.
- The guard can only ever **force `scale = 0` on present data that definitively triggers an inclusive boundary**. It can never block watering on absent or uncertain data.

## Testing

- **`evaluateSkips` (pure units):** each rule fires/does-not at the inclusive boundary; `minTemp ?? temp` fallback (local case); a missing field disables only its own rule while others still evaluate; first-trigger-wins ordering (freeze before wind before rain); nothing enabled -> `{ skip: false }`; reason strings are ASCII-only (no `= < > "`).
- **Memo:** key isolation (different provider / coords / PWS -> different entries); TTL expiry forces a refetch; `getWeatherData` throw -> `undefined`, no failure memoized.
- **Route-level (`weather.spec.ts`):**
  - A freezing `getWeatherData` forces `scale = 0` and `rawData.skipReason` survives `convertToLegacyFormat`, verified across two **always-present** methods (**Zimmerman and ETo**) so the suite does not depend on the WaterBudget feature existing in the branch; optionally add WaterBudget as a third case when it is present.
  - A **cache-hit** request is still skip-evaluated (proves live evaluation, not cached skip).
  - The existing restriction has already set `scale = 0` **and** no skip fires -> the guard adds **no** `skip`/`skipReason` and preserves the restriction's `0` (proves the guard neither invents nor erases metadata).
  - A skipped legacy (querystring) response round-trips intact.

## Out of Scope (v1)

- Live sub-hour "is it raining now" reactivity (the firmware's rain sensor owns this).
- Skip-as-*reduction* (v1 is a hard `scale = 0`).
- Per-zone skips (the service operates per location; the firmware owns zones).
- Dynamic / ET-derived thresholds; provider-specific skip tuning.
- **"All guards live / cache only the raw method result"** — restructuring the route so the California restriction is *also* re-evaluated live (and the cache holds only the pre-restriction method result). This is a separate, optional follow-up; this feature deliberately leaves the existing cache and restriction semantics untouched and only adds the additive skip overlay.

## Cross-Cutting Constraints

- Wire-format is **additive** — only `skip` and `skipReason` are added to `rawData`; the existing response is otherwise unchanged.
- **Default-off** — no behavior change for any existing user until a skip is enabled.
- ASCII-only reason strings.
- The pure `evaluateSkips` holds all policy logic with no I/O, maximizing testability; the guard layer owns only data acquisition, fail-open handling, and response assembly.
