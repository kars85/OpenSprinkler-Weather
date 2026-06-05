# Water-Budget Adjustment Method — Design Spec

- **Date:** 2026-06-05
- **Status:** Approved (brainstorming) — ready for implementation planning
- **Component:** OpenSprinkler-Weather (TypeScript / Express weather → watering-scale service)
- **Tracking:** brainstorming session 2026-06-05; design questions resolved via a four-way AI debate (Claude, Sonnet, Codex, Gemini)

## Problem & Goal

Today the service is a **stateless calculator**: weather in → a daily `watering scale %` out, with no memory. Each of the four adjustment methods (Manual, Zimmerman, Rain-delay, FAO-56 ETo) discounts *today's* watering by *today's* weather and forgets everything.

This feature adds a **soil-moisture water-budget**: a *stateful* model that tracks a running, rain-discounted water deficit per location, so that (for example) a heavy rain two days ago still suppresses today's watering, and a sustained dry/hot spell ramps watering up. It is the conceptual upgrade from "weather discount" to "track how wet the soil is and water to refill it."

This is the first of several possible enrichment features (insight dashboards, integrations, restriction rules); those are explicitly out of scope here but the design leaves seams for them.

## Design Decisions (resolved in debate)

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| Q1 | Loop closure for the unknown `waterApplied` term | **Open-loop** (track ET-out vs rain-in only) | The only option that ships now with no firmware changes and no drift-prone schedule config. The cap + normalization (below) encode the "controller follows the scale" assumption the service already relies on. |
| Q2 | Deployment target for v1 | **Local self-hosted**, with a storage seam for hosted later | The author maintains a fork and cannot deploy state to opensprinkler.com's production infra; the real target is a self-hosted instance. The pluggable store (Q3) keeps the hosted door open without paying multi-tenant complexity now. |
| Q3 | Persistence mechanism | **Pluggable `StateStore` interface**, flat-file adapter as the local default | AWS Elastic Beanstalk's filesystem is ephemeral, so SQLite/JSON-on-disk is wrong for the hosted case; the interface lets a future S3/Redis adapter drop in. The file adapter matches the existing `geocoderCache.json` pattern and needs no new dependency. |
| Q4 | Integration shape | **New opt-in adjustment method `4` (`WaterBudget`)** that reuses `calculateETo` | A true water-budget works in the **depth domain** (inches of ET, rain, deficit), not in dimensionless scale-%. A scale-% wrapper would discard the depth the balance needs and have to recompute ET anyway. A method fits the existing polymorphic `AdjustmentMethod` interface cleanly and is opt-in just like ETo. |
| Q5 | Insight scope for this spec | **Model + persistence + decision-log + a human-readable `reason`**; defer dashboard/trends UI | The "why" is a JSON field (the OpenSprinkler app can render it) — high value, low cost. A dashboard is a separate product surface (frontend, auth on the hosted side); the logged data makes it a trivial later cycle. |

## Architecture & Components

A new method, `WaterBudgetAdjustmentMethod` (selector ID `4`), implements the existing `AdjustmentMethod` interface alongside Manual(0)/Zimmerman(1)/RainDelay(2)/ETo(3). Users opt in by selecting method `4`, exactly as they select ETo today. **No change to the firmware wire format** — it returns the same `scale` and `rawData` the firmware already parses.

Four independently testable units:

1. **`WaterBudgetAdjustmentMethod`** — orchestrator. Fetches demand/rain (reusing `calculateETo` for depth-domain ET), loads prior state, runs the model, persists new state, appends a decision record, returns `{ scale, rawData }`.
2. **`SoilMoistureModel`** — **pure function**, no I/O: `step(prevState, ETc, effRain, refETc, params) → { newState, scale, reason }`. The heart of the feature; fully unit-testable without mocks.
3. **`StateStore` + `FileStateStore`** — persistence behind an async interface.
4. **`DecisionLog`** — append-only, bounded per-location history (lives inside the persisted state).

**Reuse, don't reinvent:** demand comes from the existing `calculateETo(...)` (depth domain, inches), and the normalization reference comes from the existing `baselineETo` data the service already ships. Geocoding (address → coordinates) is the existing upstream `resolveCoordinates(location)`; this feature inherits it unchanged.

## The Model (open-loop, rain-discounted ET accumulator)

### Persisted state (per location)
- `rainBank` — inches of stored effective rain not yet consumed by ET (≥ 0). This is the single piece of memory.
- `lastUpdated` — `YYYY-MM-DD` of the last computation (idempotency + gap detection)
- `lastScale` — last returned scale (used for stale-data fallback)
- `history` — capped ring buffer of `DecisionRecord` (≈ last 90 days)

### Daily update (rain-bank model)
```
ETc           = calculateETo(weather) * Kc                       // today's demand, inches
referenceETc  = baselineDailyETo(location) * Kc                  // a normal day's demand, inches
effectiveRain = measuredOrForecastPrecip * runoffFactor          // inches
available     = rainBank + effectiveRain                          // water on hand from past+today rain
metByRain     = min(ETc, available)                              // rain covers this much of today's demand
unmetDemand   = ETc - metByRain                                   // what irrigation must cover today
rainBank      = min(available - metByRain, rainBankCap)           // surplus rain carried forward (capped)
scale         = clamp(round(100 * unmetDemand / referenceETc), 0, maxScale)
```

- **No `waterApplied` term (open-loop).** Irrigation implicitly covers `unmetDemand` each day; only *rain* is banked and carried. On a normal dry day `rainBank = 0`, so `unmetDemand = ETc` and `scale = 100 * ETc / referenceETc` ≈ **100%** — the correct steady state. A rain event fills the bank and covers demand for the following days, holding `scale` near 0 until the bank drains (**multi-day rain memory**). A heat wave drives `ETc > referenceETc`, ramping `scale` toward `maxScale`. *(This corrects an earlier draft whose `deficit`-accumulator pinned dry weather at 200% instead of 100%.)*
- **Normalize to local annual-average normal:** `referenceETc = baselineDailyETo(location) * Kc`. The shipped `baselineETo` binary stores **one annual-average daily ETo per location** (it is not day-of-year specific), so "100%" means *a normal day for this location*; summer naturally exceeds 100%, winter falls below. Reuses the existing `baselineETo` data file.
- **Memory cap:** `rainBankCap = rainBankCapDays * referenceETc` (default `rainBankCapDays = 14`) so a freak storm can't suppress watering for months.

### Parameters

| Param | Default | Meaning |
|---|---|---|
| `Kc` | 0.9 (static, configurable) | crop water-use factor; v1 uses a single static value. Reusing ETo's dynamic per-season `TurfgrassManager` Kc is a deliberate future enhancement, not v1. |
| `maxScale` | 200% | upper clamp (matches Zimmerman) |
| `runoffFactor` | 1.0 | fraction of rain counted effective |
| `rainBankCapDays` | 14 | max days of rain memory (`rainBankCap = rainBankCapDays * referenceETc`) |
| `gapResetDays` | 2 | gap length that triggers a memory reset |

### Edge behaviors
- **Cold start** (no prior state): `rainBank = 0` → first run computes from today's weather (≈ 100% on a normal day); memory builds from there.
- **Service-down gap** longer than `gapResetDays`: missed-day weather is unknown, so reset `rainBank = 0` (conservative — assume no stored rain) and note it in the `reason`, rather than fabricate history.
- **Same-day re-poll** (`lastUpdated == today`): return the stored result; do not re-accumulate (idempotent).
- **Missing weather fields:** see Error Handling — do not corrupt the balance.

## Persistence

```
interface StateStore {
  get(key: string): Promise<BudgetState | undefined>;
  set(key: string, state: BudgetState): Promise<void>;
}
```

- **`FileStateStore`** loads one JSON file on boot into an in-memory map (runtime source of truth) and flushes back **atomically** (write temp → `fs.renameSync`, the pattern already used by the hardened geocoder cache). In-memory-first avoids read-modify-write races and disk thrash on a Raspberry Pi; the `async` interface lets a future S3/Redis adapter drop in unchanged.
- **Key** = resolved coordinates rounded to ~4 dp (`"42.3732,-72.5199"`) — the same canonicalization the existing watering cache uses, so locations that geocode to the same point share state.
- **Bounded by design:** per-location `history` is capped (≈ 90 entries); this prevents the unbounded-growth failure mode. (A keyspace eviction policy for very-high-cardinality deployments is deferred to the hosted-adapter cycle; the file adapter targets the single/few-location self-hosted case.)

### `BudgetState`
```
{
  rainBank: number,           // inches of stored effective rain
  lastUpdated: "YYYY-MM-DD",
  lastScale: number,
  history: DecisionRecord[]   // capped ring buffer (~90)
}
```

## Decision Log & the Response

Each computation appends one `DecisionRecord` (the entire "insight" payload for now — no UI):
```
{ date, scale, eto, etc, effectiveRain, unmetDemand, rainBankBefore, rainBankAfter,
  referenceEtc, resolvedLocation, reason }
// eto = reference ETo (from calculateETo); etc = eto * Kc (today's demand);
// referenceEtc = baselineDailyETo * Kc (the 100%-normalizer)
```
A future dashboard (separate cycle) reads this array; deferring the UI costs nothing because the data is captured from day one.

The method adds **one additive field** to `rawData`: `reason` — a short human-readable string, e.g.:
> `"Scale 0%: ~0.6\" of stored rain still covers demand."` or `"Scale 100%: dry conditions; watering at 100% of normal."`

`rawData` is already a free-form object in the response, so this is **wire-compatible**: firmware that ignores it is unaffected; the OpenSprinkler app that wants it gets the explanation.

## Address Input & Geocoding (already supported; documented here)

Coordinates are derived from the `loc` request parameter upstream in `resolveCoordinates(location)`, so this feature works with any location form with no new code:

- GPS (`"42.37,-72.52"`) — used directly.
- Otherwise handed to the configured geocoder:

| Geocoder | Backend | Best for | Needs key? |
|---|---|---|---|
| `WUnderground` (default) | `autocomplete.wunderground.com` | city / ZIP / place names | no |
| `GoogleMaps` | Maps Geocoding API (`address=…`) | **full street addresses** | yes (`GOOGLE_MAPS_API_KEY`) |

Documentation will state that `loc` accepts ZIP / place / GPS / **street address**, and recommend `GEOCODER=GoogleMaps` for street-address precision. The model carries a `resolvedLocation` field so a place name *can* be echoed in the `reason` / decision log, but v1 geocoders return coordinates only — so a friendly place name in the reason is a future enhancement (it stays `undefined` in v1). Adding a new geocoder or changing the default is **out of scope**.

## Configuration

**Environment-only in v1.** Per-request `kc`/`mx` overrides were considered but dropped: state advances once per calendar day and same-day re-polls are idempotent, so a same-day override could not take effect and would mislead. Per-request tuning is a future enhancement. (Site `elevation` may still be passed per request, as today.)

| Setting | env var | default |
|---|---|---|
| crop coefficient | `BUDGET_KC` | 0.9 |
| max scale | `BUDGET_MAX_SCALE` | 200 |
| runoff factor | `BUDGET_RUNOFF` | 1.0 |
| rain-bank cap (days) | `BUDGET_RAINBANK_CAP_DAYS` | 14 |
| gap-reset days | `BUDGET_GAP_RESET` | 2 |
| site elevation (ft) | `BUDGET_ELEVATION` | 600 |
| fallback reference ETo (in/day) | `BUDGET_DEFAULT_REF_ETO` | 0.15 |
| state file path | `BUDGET_STATE_FILE` | `waterBudgetState.json` (git-ignored) |
| geocoder (existing) | `GEOCODER` | `WUnderground` |

## Error Handling — fail open, never corrupt state, never crash watering

- **Negative / missing ETo:** `calculateETo` has no lower bound and can return a small negative value; the model clamps `ETc` (and `referenceETc`) to `≥ 0` so a negative ETo can never inflate the rain bank (fake memory).
- **Transient weather failure** (provider down / fields missing): do not touch `rainBank`; return the last stored `scale` with a `reason` flagged `(stale: weather unavailable)`. If there is no stored state yet, propagate a coded error (today's behavior).
- **State-store read/write failure:** treat as a cold start (`rainBank = 0`), log a WARN, continue. A disk hiccup must never block irrigation.
- **Baseline ETo unavailable** (data file absent / out of bounds): fall back to `BUDGET_DEFAULT_REF_ETO` as the normalizer.
- **Corrupt state file:** recover by starting empty (do not throw); atomic writes should prevent partial files, but defend anyway.
- **Geocode failure:** unchanged (existing coded error).
- All errors funnel through the existing `CodedError` / `makeCodedError` path so no secrets leak (consistent with prior redaction work).

## Response-format compatibility (must-fix)

`convertToLegacyFormat()` in `weather.ts` reduces `rawData` to `{ wp }` for any method except ETo/Zimmerman, and runs by default (`SIMPLIFIED_RESPONSE_FORMAT`). The implementation **must add a WaterBudget branch** that preserves `reason`/`bank`/`eto`/`etc`/`p`, and a **route-level test** (through `getWateringData`, not just the method) must assert the `reason` survives — the direct-method unit tests do not exercise this path. The per-method watering-scale cache is compatible (it is keyed by method id and serves the stored `rawData`, advancing state once per day).

## Testing

- **`SoilMoistureModel.step` — pure unit tests, no mocks** (primary confidence):
  - rain memory (rain drops scale, drains over N days), dry-spell ≈ 100%, heat-wave ramp > 100%, cold start ≈ 100%, gap > threshold resets, same-day idempotency, rain-bank cap, **negative ETo never inflates the bank**, clamping bounds.
- **`FileStateStore`:** load/save round-trip, atomic-write behavior, corrupt-file → empty recovery, persistence across instances.
- **Method behavior** (mock provider): rain ⇒ 0%, persistence across calls, idempotency, stale-hold on weather failure, coded error when weather fails with no prior state.
- **Route-level (must-have):** through `getWateringData` with adjustment method `4`, assert the response carries a numeric `scale` and a `rawData.reason` (proving `convertToLegacyFormat` preserves it and the cache path integrates).
- **Determinism / wire-format:** fixed inputs → fixed outputs (TZ-pinned, matching the determinism fix already in the suite); the legacy response still parses and `rawData.reason`/`bank` are additive-only.

## Out of Scope (future cycles)

- Dashboard / trends UI (reads the decision log).
- Hosted multi-tenant `StateStore` adapter (S3 / Redis / Dynamo) + tenant identity + keyspace eviction.
- Closed-loop firmware telemetry (`waterApplied` reporting) for an exact balance.
- New geocoders or changing the default geocoder.
- Per-zone modeling (the service sees one location; the firmware owns zones).

## Cross-Cutting Constraints

- Legacy firmware response wire-format stays byte-compatible; the only response change is the additive `rawData.reason` key.
- TypeScript, existing project conventions; no heavyweight dependencies (the file store reuses Node `fs`).
- The risky hydrology logic is isolated in a pure function with no I/O, maximizing testability and reviewability.
