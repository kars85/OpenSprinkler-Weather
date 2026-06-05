# Weather Provider Fallback — Design Spec

**Date:** 2026-06-05
**Status:** Approved for planning (pending user read-through)
**Feature:** Opt-in resilience — when a weather provider fails transiently, fall through to the next provider in a configured chain.

---

## 1. Problem & Goal

Today, provider selection in `routes/weather.ts` is **failure-blind**: it picks one `WeatherProvider` (by `wto.provider`, defaulting to `Apple` for unknown keys, or `PWS_WEATHER_PROVIDER` when a PWS is configured) and any error from that provider's `getEToData` / `getWateringData` / `getWeatherData` call propagates straight to the client. A single provider's transient outage (API down, timeout, malformed payload) breaks the watering calculation even when other configured providers could have answered.

**Goal:** an **opt-in**, **stateless** fallback chain. When the active provider fails with a *transient/data* error (or cannot service the requested method), try the next provider in an operator-configured order. Preserve today's exact behavior when the feature is unconfigured.

**Non-goals (out of scope):** circuit breaker / failure memoization, multi-PWS fallback, per-provider health metrics/dashboards, and the broader "cache the raw method result" refactor.

---

## 2. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| D1 | **Config model** | Global env chain `WEATHER_PROVIDER_FALLBACKS` (ordered provider keys), optionally overridden per-request via `wto.fallbacks`. |
| D2 | **Fallback trigger** | Transient/data errors **+ unsupported-method**. Never auth/config errors. (§5) |
| D3 | **PWS path** | **Default = Option A** (honor the PWS; error on failure). **Opt-in Option B-with-conditions** via `PWS_FALLBACK_ENABLED`. (§6) |
| D4 | **Retry strategy** | **Naive per-request, stateless.** Try chain in order each request; no cross-request state. |
| D5 | **Architecture** | **Composite/decorator** `FallbackWeatherProvider implements WeatherProvider`. (§3) |

D3 rationale recorded via four-way `/octo:debate` (Gemini/Codex/Sonnet favored B-default for irrigation safety; Opus countered that the firmware retains the last good scale on error and that an explicit PWS ID + key is the strongest intent signal — landing on A-default + opt-in B; user adopted).

> **⚠️ Verification task (carry into plan):** D3's default hinges on *what an OpenSprinkler controller does when the weather call errors* — retain the last successful scale (assumed) vs. snap to 100%. If controllers default to 100%, reconsider flipping the default to B-on. Confirm against firmware before release.

---

## 3. Architecture — Composite Provider

New module: `routes/weatherProviders/FallbackWeatherProvider.ts`.

```
class FallbackWeatherProvider extends WeatherProvider {
  constructor(private readonly chain: WeatherProvider[]) { super(); }
  // For each interface method: try chain[i]; on a fallback-eligible error, advance.
  // On a non-eligible error, rethrow immediately. If all fail, throw the last-tried error.
  // Records per-request: servedIndex, served (the provider that answered), pwsBypassed.
}
```

**Why composite (vs. retry loops at the call sites):** providers are already interchangeable `WeatherProvider` instances. The composite is transparent to all three call paths — the adjustment method (`calculateWateringScale(... weatherProvider ...)`), the restriction-check `getWateringData` call, and the `/weather` endpoint's `getWeatherData` call — with no changes to adjustment-method internals. Fallback logic lives in exactly one place.

**Per-request construction.** The composite is built **per request** (a cheap array wrapping the existing module-level singleton providers). This lets it carry per-request state (`served`, `pwsBypassed`) with **no shared-state races**. The singleton providers themselves remain shared and stateless.

**Opt-out is the default.** If the resolved chain has length 1 (env unset and no `wto.fallbacks`), the resolver returns the **bare provider, unwrapped** — byte-for-byte today's behavior, and (critically) preserving `instanceof` checks (see §4).

---

## 4. Forecast-capability detection (regression fix)

`EToAdjustmentMethod.ts:352` gates the enhanced-forecast path on:

```ts
if (weatherProvider instanceof EnhancedWeatherProvider && weatherProvider.supportsForecasting()) { ... }
```

Two problems this design must handle:

1. **Wrapping hides capability.** A `FallbackWeatherProvider extends WeatherProvider` is **not** `instanceof EnhancedWeatherProvider`, so wrapping a forecast-capable provider (e.g. `local`) silently disables forecasting.
2. **Pre-existing latent bug.** There are **two distinct** `EnhancedWeatherProvider` classes — `weatherProviders/local.ts:37` and `weatherProviders/OpenMeteo.ts:25`. The `instanceof` at line 352 imports only the `local.ts` one, so an `OpenMeteo` provider already fails the check today and never forecasts.

**Decision (D6): replace the `instanceof` with a structural capability check** and make the composite forecast-aware.

- Change the guard to duck-typed capability detection, e.g.:
  ```ts
  function supportsForecast(wp: any): boolean {
    return typeof wp?.supportsForecasting === "function" && wp.supportsForecasting();
  }
  ```
- `FallbackWeatherProvider` implements the forecast surface (`supportsForecasting()`, `getForecastData()`, `getBestForecastMethod()`) by **delegating to the first forecast-capable provider in its chain** (in practice the primary). `supportsForecasting()` returns true iff any chain member supports it.

**Consciously accepted consequence:** the structural check *also* activates `OpenMeteo`'s forecast path, which is currently dead. This is arguably a latent-bug fix, but it is a behavior change for OpenMeteo users and **must be called out in the plan/PR** (and covered by a test) rather than shipped silently. The forecast block is already best-effort (wrapped in `try/catch`, gated by `ENABLE_FORECAST`), which bounds the blast radius.

*Accepted nuance:* when the primary serves the forecast but historical ETo came from a fallback, the two data sources differ within one calculation. Forecast is an opt-in enhancement and best-effort; full forecast-source fallback is out of scope.

---

## 5. Error classification

A single shared predicate (colocated with the composite, importing `ErrorCode` from `errors.ts`):

```ts
function isFallbackEligible(err: unknown): boolean
```

**Eligible (advance to next provider):**
- `CodedError` with `errCode` ∈ { `BadWeatherData (1)`, `InsufficientWeatherData (10)`, `MissingWeatherField (11)`, `WeatherApiError (12)`, `UnsupportedAdjustmentMethod (40)` }.
- **Raw (non-Coded) errors only if network/timeout-shaped** — `err.code` ∈ { `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN` } or message matches `/timed out/i`.

**Never eligible (rethrow immediately):**
- PWS/config: `InvalidPwsId (30)`, `InvalidPwsApiKey (31)`, `PwsAuthenticationError (32)`, `PwsNotSupported (33)`, `NoPwsProvided (34)`, `NoAPIKeyProvided (35)`.
- Location errors (`2x`), option errors (`5x`), invalid-method (`41`).
- **`UnexpectedError (99)` and any other raw error** — deliberately *not* eligible, so genuine provider bugs surface instead of being masked by silent fallback.

Rationale: auth/config failures are deterministic — every provider would fail (or the swap would mask a fixable user error). Bugs (`99`/unknown) should be loud.

---

## 6. PWS path

**Default (Option A):** when a PWS is configured (`pws.id` set), the resolver returns the bare `PWS_WEATHER_PROVIDER`. A PWS failure surfaces as an error — the user's explicit station choice is honored, and an auth/config error is never masked.

**Opt-in (Option B-with-conditions):** when `PWS_FALLBACK_ENABLED === "true"`, the resolver builds a composite `[PWS_WEATHER_PROVIDER, ...coordinate chain]`. The §5 predicate still **hard-fails on auth/config** (a revoked/typo'd key never silently degrades to grid data). Coordinate providers ignore the `pws` arg and use `coordinates`. When a non-PWS member serves, the composite sets `pwsBypassed = true`.

---

## 7. Provider selection — single resolver (refactor)

Selection logic is currently duplicated at `weather.ts:265` (`/weather` endpoint) and `weather.ts:348` (watering flow). Extract:

```ts
function resolveWeatherProvider(
  adjustmentOptions: AdjustmentOptions,
  pws: PWS | undefined
): WeatherProvider   // bare provider, or FallbackWeatherProvider when a chain is configured
```

Responsibilities: honor `WEATHER_PROVIDER === "local"`; pick primary (`WEATHER_PROVIDERS[provider] || Apple`); resolve the fallback chain from `WEATHER_PROVIDER_FALLBACKS` (env) overridden by `wto.fallbacks` (per-request); apply PWS rules (§6); **return the bare provider when the chain length is 1**. Both call sites use this resolver. Unknown provider keys in a chain are skipped (logged), not fatal.

---

## 8. Observability / response metadata

- `rawData.wp` already reports the **actual** serving provider — the composite ensures the served child's name flows through (it returns the child's data unchanged).
- **Bypass flag:** `pwsBypassed: true` + `pwsBypassReason` (e.g. the failing errCode) are surfaced on `rawData`.
- **Plumbing (matches the existing skip pattern):** adjustment methods rebuild `rawData` from provider data, so extra fields on `EToData`/`ZimmermanWateringData` do **not** survive. Instead, after `calculateWateringScale(...)` returns, `weather.ts` reads the composite's per-request state (`served`, `pwsBypassed`) and merges `pwsBypassed`/`pwsBypassReason` into `dataToSend.rawData` — the same injection point used by the weather-skips overlay. Extend the **universal passthrough** in `convertToLegacyFormat` (`weather.ts:139`, which today forwards only `skip`/`skipReason`) to also forward `pwsBypassed`/`pwsBypassReason`.
- **Logging:** each fall-through emits a redacted `console.error`/`debugLog` (`from → to`, errCode) via the existing `redactLogValue` helpers.

---

## 9. Caching interaction

`WateringScaleCache.storeWateringScale` caches **until the end of the local day** (`WateringScaleCache.ts:30`, `.endOf("day")`) — *not* a short TTL. So a fallback-sourced scale, if cached, would be **pinned for the rest of the day**.

**Rules:**
- `FallbackWeatherProvider.shouldCacheWateringScale()` returns the **primary's** value.
- **Suppress the store when a fallback actually served:** `weather.ts` skips `storeWateringScale(...)` (`weather.ts:409`) when the composite reports `served !== primary`. This prevents pinning a degraded/coarser scale until end-of-day. Cache **lookup** (`weather.ts:366`) is unaffected — it is keyed by request params, not provider, so a previously-cached primary result stays valid.
- Deeper cache-coherence (per-provider cache keys, caching fallback results with shorter TTL) is **out of scope**.

---

## 10. Error semantics on total failure

If every provider in the chain fails, the composite throws the **last-tried** error (most-recent ground truth). It propagates through the existing `sendWateringError` path unchanged — same behavior the single-provider path has today. The restriction-check `getWateringData` call (`weather.ts:397`) likewise benefits from the chain transparently.

---

## 11. Testing strategy

Pure unit tests, no network (stub `WeatherProvider`s):

- **`isFallbackEligible`:** each eligible errCode advances; each auth/config/`99`/location code rethrows; raw `ETIMEDOUT`/`ECONNREFUSED` advance; arbitrary raw `Error` rethrows.
- **Composite:** first fails transient → second serves; first fails auth → rethrows (no further calls); all fail → throws last error; `UnsupportedAdjustmentMethod` → advances; chain length 1 → resolver returns bare provider (no wrapper).
- **Forecast:** composite reports `supportsForecasting()` from chain; structural check in `EToAdjustmentMethod` activates for the composite; OpenMeteo forecast-path activation covered/acknowledged.
- **PWS:** default → bare PWS provider, failure throws; `PWS_FALLBACK_ENABLED` → `[PWS, ...chain]`, transient PWS error → coordinate provider serves with `pwsBypassed=true`; PWS auth error → rethrow, no bypass.
- **Metadata:** `pwsBypassed`/`pwsBypassReason` merged into `rawData` and survive `convertToLegacyFormat`.
- **Cache:** store suppressed when a fallback served; lookup unaffected.

---

## 12. Affected files

| File | Change |
|------|--------|
| `routes/weatherProviders/FallbackWeatherProvider.ts` | **New.** Composite + `isFallbackEligible`. |
| `routes/weather.ts` | New `resolveWeatherProvider` helper (replaces selection at `:265` & `:348`); merge `pwsBypassed` into `rawData` after `calculateWateringScale`; suppress cache store on fallback; extend `convertToLegacyFormat:139` passthrough. |
| `routes/adjustmentMethods/EToAdjustmentMethod.ts` | Replace `instanceof EnhancedWeatherProvider` (`:352`) with structural `supportsForecast()` check. |
| `docs/weather-provider-fallback.md` + `README` | **New/updated.** Operator guide: `WEATHER_PROVIDER_FALLBACKS`, `wto.fallbacks`, `PWS_FALLBACK_ENABLED`. |

---

## 13. Configuration summary

| Setting | Type | Default | Effect |
|---------|------|---------|--------|
| `WEATHER_PROVIDER_FALLBACKS` | env, CSV of provider keys | unset | Ordered fallback chain appended after the primary. Unset ⇒ no fallback. |
| `wto.fallbacks` | per-request, list | absent | Overrides the env chain for that request. |
| `PWS_FALLBACK_ENABLED` | env, `"true"`/unset | unset (off) | Enables Option-B fallback for the PWS path (errCode-gated, bypass flagged). |
