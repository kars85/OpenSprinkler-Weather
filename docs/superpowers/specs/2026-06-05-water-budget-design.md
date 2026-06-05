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
- `deficit` — inches of accumulated, rain-discounted water demand (≥ 0)
- `lastUpdated` — `YYYY-MM-DD` of the last computation (idempotency + gap detection)
- `lastScale` — last returned scale (used for stale-data fallback)
- `history` — capped ring buffer of `DecisionRecord` (≈ last 90 days)

### Daily update
```
ETc           = calculateETo(weather) * Kc                       // demand, inches
effectiveRain = measuredOrForecastPrecip * runoffFactor          // inches; excess discarded by the floor
deficit       = clamp(deficit + ETc - effectiveRain, 0, deficitCap)
scale         = clamp(100 * deficit / referenceETc, 0, maxScale)
```

- **No `waterApplied` term (open-loop).** In sustained dry weather `deficit` rises and pins at `deficitCap`, so `scale` rests at its steady state (≈ 100% = a normal program day) — correct, because in a dry spell you water normally on every scheduled day. A rain event subtracts from `deficit`, holding `scale` below 100% for as many days as it takes ET to rebuild it (**multi-day rain memory**). A heat wave drives `ETc > referenceETc`, ramping `scale` toward `maxScale`.
- **Normalize to local seasonal normal:** `referenceETc = baselineETo(location, dayOfYear) * Kc`, using the shipped `baselineETo` data, so "100%" means *normal for this place and season*.
- **Cap:** `deficitCap = (maxScale / 100) * referenceETc` (e.g. 2× ref → a 200% ceiling).

### Parameters

| Param | Default | Meaning |
|---|---|---|
| `Kc` | 0.9 (static, configurable) | crop water-use factor; v1 uses a single static value. Reusing ETo's dynamic per-season `TurfgrassManager` Kc is a deliberate future enhancement, not v1. |
| `maxScale` | 200% | upper clamp (matches Zimmerman) |
| `runoffFactor` | 1.0 | fraction of rain counted effective (excess discarded by the deficit floor) |
| `gapResetDays` | 2 | gap length that triggers a neutral reset |

### Edge behaviors
- **Cold start** (no prior state): `deficit = referenceETc` → first run is a neutral 100%, then memory builds.
- **Service-down gap** longer than `gapResetDays`: missed-day weather is unknown, so reset `deficit = referenceETc` (neutral) and note it in the `reason`, rather than fabricate history.
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
  deficit: number,            // inches
  lastUpdated: "YYYY-MM-DD",
  lastScale: number,
  history: DecisionRecord[]   // capped ring buffer (~90)
}
```

## Decision Log & the Response

Each computation appends one `DecisionRecord` (the entire "insight" payload for now — no UI):
```
{ date, scale, eto, etc, effectiveRain, deficitBefore, deficitAfter,
  referenceEtc, resolvedLocation, reason }
// eto = reference ETo (from calculateETo); etc = eto * Kc (demand);
// referenceEtc = baselineETo * Kc (the 100%-normalizer)
```
A future dashboard (separate cycle) reads this array; deferring the UI costs nothing because the data is captured from day one.

The method adds **one additive field** to `rawData`: `reason` — a short human-readable string, e.g.:
> `"Scale 45%: soil still moist from 1.1\" rain 2 days ago (deficit 0.09\" of 0.20\" normal) for Amherst, MA"`

`rawData` is already a free-form object in the response, so this is **wire-compatible**: firmware that ignores it is unaffected; the OpenSprinkler app that wants it gets the explanation.

## Address Input & Geocoding (already supported; documented here)

Coordinates are derived from the `loc` request parameter upstream in `resolveCoordinates(location)`, so this feature works with any location form with no new code:

- GPS (`"42.37,-72.52"`) — used directly.
- Otherwise handed to the configured geocoder:

| Geocoder | Backend | Best for | Needs key? |
|---|---|---|---|
| `WUnderground` (default) | `autocomplete.wunderground.com` | city / ZIP / place names | no |
| `GoogleMaps` | Maps Geocoding API (`address=…`) | **full street addresses** | yes (`GOOGLE_MAPS_API_KEY`) |

Documentation will state that `loc` accepts ZIP / place / GPS / **street address**, and recommend `GEOCODER=GoogleMaps` for street-address precision. The resolved place name is echoed in the `reason` / decision log so an address user can confirm correct geocoding. Adding a new geocoder or changing the default is **out of scope**.

## Configuration

Per-request via `wto` options with env-var defaults (same pattern as Zimmerman/ETo):

| Setting | env default | `wto` override |
|---|---|---|
| crop coefficient | `BUDGET_KC` (≈ 0.9) | `kc` |
| max scale | `BUDGET_MAX_SCALE` (200) | `mx` |
| runoff factor | `BUDGET_RUNOFF` (1.0) | — |
| gap-reset days | `BUDGET_GAP_RESET` (2) | — |
| state file path | `BUDGET_STATE_FILE` | — |
| geocoder (existing) | `GEOCODER` (WUnderground) | — |

## Error Handling — fail open, never corrupt state, never crash watering

- **Transient weather failure** (provider down / missing fields): do not touch `deficit`; return the last stored `scale` with a `reason` flagged `(stale: weather unavailable)`. If there is no stored state yet, fall back to the chosen base method's existing coded error.
- **State-store read/write failure:** compute as a cold start (`deficit = referenceETc` → neutral 100%), log a WARN, continue. A disk hiccup must never block irrigation.
- **Corrupt state file:** recover by treating that key as cold-start (do not throw); atomic writes should prevent partial files, but defend anyway.
- **Geocode failure:** unchanged (existing coded error).
- All errors funnel through the existing `CodedError` / `makeCodedError` path so no secrets leak (consistent with prior redaction work).

## Testing

- **`SoilMoistureModel.step` — pure unit tests, no mocks** (primary confidence):
  - rain memory (a 1″ rain drops scale, recovers to ~100% over N days), dry-spell pin at 100%, heat-wave ramp > 100%, cold start = 100%, gap > threshold resets, same-day idempotency, clamping bounds.
- **`FileStateStore`:** load/save round-trip, atomic-write behavior, bounded-history eviction, corrupt-file → cold-start recovery.
- **End-to-end** (following the existing OWM regression-test pattern with a mocked provider): drive `WaterBudgetAdjustmentMethod` over a multi-day weather sequence and assert the scale *trajectory*, the `reason`, and the persisted `deficit`.
- **Determinism / wire-format:** fixed inputs → fixed outputs (TZ-pinned, matching the determinism fix already in the suite); assert the legacy response still parses and `rawData.reason` is additive-only.

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
