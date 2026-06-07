# `/v1` Read API — Design Spec

**Date:** 2026-06-06
**Status:** Approved for planning (pending user read-through)
**Feature:** A versioned, smart-home-friendly JSON read API (`/v1/watering`, `/v1/weather`, `/v1/budget`). First sub-project of the smart-home integration; MQTT publishing is a separate follow-up that will consume this layer.

---

## 1. Problem & Goal

The server today exposes only firmware-shaped endpoints: the watering endpoints (`/(\d+)`, `/weather\d+.py` → legacy query-string format) and `/weatherData` (JSON weather for the mobile app). There is no stable, documented JSON contract a smart-home consumer (Home Assistant) or a future dashboard can rely on, and the Water-Budget decision history / rain-bank is not exposed at all.

**Goal:** add a `/v1` read API with three endpoints — a clean watering **decision**, current **weather**, and Water-Budget **insight** (rain bank + recent decisions) — that returns the *same* watering decision the firmware gets (not a "fresher" parallel one), via a shared compute core.

**Scope (decided):** `/v1` read API only. MQTT, write/control endpoints, auth tokens, OpenAPI generation, and the dashboard UI are out of scope (later cycles; the dashboard would consume `/v1`).

---

## 2. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| D1 | **Reuse model** | Extract a shared `computeWateringDecision()` core used by **both** the legacy handler and `/v1`, so cache, fallback-meta, restriction, and skips are identical (no drift). Behavior-preserving extraction. |
| D2 | **Endpoints** | `GET /v1/watering` (live decision), `GET /v1/weather` (conditions), `GET /v1/budget` (stored insight). |
| D3 | **Param contract** | Clean query params (not the legacy `wto` blob). `loc` required everywhere; `/v1/watering` adds `method` (required int 0–4) + optional `restrict`, `provider`, `pws`, `key`. |
| D4 | **Auth** | None new — global helmet + rate-limit + `cors()` like the existing read endpoints. |
| D5 | **Errors** | HTTP status + `{ "error": { "code", "message" } }` (no legacy `errCode`); messages redacted. |

---

## 3. Architecture — shared compute core + `/v1` router

### 3.1 `computeWateringDecision` (extracted into `weather.ts`, exported)

A behavior-preserving extraction of the decision body currently inside `getWateringData` — provider selection, cache lookup/store, calculation, restriction, fallback-metadata merge, and the skip overlay. The **legacy handler keeps** req parsing, `wto` decode, firmware detection, the time/sun/`eip` fields, and legacy formatting; it calls the core for the decision. `/v1` calls the same core with clean params and clean formatting.

```ts
export interface WateringDecisionInput {
	coordinates: GeoCoordinates;
	adjustmentParam: number;               // full param (base method | restriction bit) — drives cache key + restriction
	adjustmentOptions: AdjustmentOptions;
	pws: PWS | undefined;
}
export interface WateringDecision {
	coordinates: GeoCoordinates;
	methodId: number;                      // base 0–4
	methodName: string;                    // adjustmentMethod constructor name
	scale: number | undefined;
	rainDelay: number | undefined;
	rawData: any;
	weatherProvider: string;               // SERVED provider (rawData.wp), not the selected class
	skip: boolean;
	skipReason?: string;
	servedFallback: boolean;
	pwsBypassed: boolean;
}
export async function computeWateringDecision( input: WateringDecisionInput ): Promise< WateringDecision >;
```

Core logic (moved ~mechanically from `getWateringData`):
1. `adjustmentMethod = ADJUSTMENT_METHOD[ adjustmentParam & ~(1<<7) ]`; if undefined → `throw new CodedError( ErrorCode.InvalidAdjustmentMethod )`.
2. `checkRestrictions = ((adjustmentParam >> 7) & 1) > 0`.
3. `weatherProvider = resolveWeatherProvider( adjustmentOptions, pws )`.
4. If `shouldCacheWateringScale()` → cache lookup; on hit use `{scale, rawData, rainDelay}` (no fallback flags).
5. Else `calculateWateringScale(...)`; restriction check via `checkWeatherRestriction(adjustmentParam, …)`; merge `pwsBypassed`/`pwsBypassReason`; store to cache **only when `!servedFallback`** (unchanged rule).
6. `applyWeatherSkips(...)` overlay on `{scale, rawData}`.
7. Return the `WateringDecision` (`weatherProvider = rawData.wp`, `skip = !!rawData.skip`, etc.).

The time/sun/`eip` fields are **not** part of the decision — the legacy handler still computes and merges them around the core result, preserving its exact output.

### 3.2 `/v1` router

New `routes/v1/index.ts` (Express `Router`), registered in `server.ts` **before** the 404 handler:

```ts
app.use( "/v1", cors(), v1Router );   // after the existing routes, before app.use(404)
```

Handlers: `/watering`, `/weather`, `/budget`, plus `sendV1Error`, `shapeWateringResponse`, `shapeWeatherResponse`, `shapeBudgetResponse`.

---

## 4. Shared helpers (extracted, used by legacy + `/v1`)

To prevent drift on the error-prone bits, extract and export from `weather.ts`:

- **`buildPwsFromParams( adjustmentOptions ): PWS | undefined`** — the exact existing rule: when `provider === "WU"` with `pws` + `key`, validate `pws` is `^[a-zA-Z\d]+$` and `key` is `^[a-f\d]{32}$`, else throw `CodedError(InvalidPwsId)` / `CodedError(InvalidPwsApiKey)`; otherwise a bare `key` becomes `{ apiKey: key }`; else `undefined`. Both legacy handlers and `/v1` call it (replacing the duplicated inline blocks).
- **`checkWeatherRestriction`** — currently private; export it so the core (and only the core) uses it.

These extractions are pure/behavior-preserving and covered by the existing route tests plus the new regression test (§7).

---

## 5. Endpoints

### 5.1 `GET /v1/watering`

Params: `loc` (required), `method` (required integer 0–4), `restrict` (optional, `1`/`true`), `provider`, `pws`, `key` (optional).

Flow: validate `method` (→ `400` if missing/non-integer/out of 0–4); `resolveCoordinates(loc)`; `adjustmentOptions = { provider, pws, key }`; `pws = buildPwsFromParams(adjustmentOptions)`; `adjustmentParam = method | (restrict ? (1<<7) : 0)`; `decision = computeWateringDecision({ coordinates, adjustmentParam, adjustmentOptions, pws })`; shape:

```json
{
  "location": [40.71, -74.0],
  "method": "WaterBudgetAdjustmentMethod",
  "methodId": 4,
  "scale": 80,
  "rainDelay": 0,
  "skip": false,
  "skipReason": null,
  "pwsBypassed": false,
  "weatherProvider": "OWM",
  "reason": "Scale 80%: ...",
  "raw": { /* full rawData */ }
}
```

`reason` = `rawData.reason ?? null`. `restrict` maps to the legacy restriction bit but is exposed as a clean boolean, **not** a bit-packed `method`.

### 5.2 `GET /v1/weather`

Params: `loc` (required), optional `provider`/`pws`/`key`.

Flow: `resolveCoordinates(loc)`; `pws = buildPwsFromParams(...)`; `provider = resolveWeatherProvider(adjustmentOptions, pws)`; `weather = provider.getWeatherData(coordinates, pws)`; shape:

```json
{
  "location": [40.71, -74.0],
  "weatherProvider": "OWM",
  "temp": 72, "humidity": 55, "wind": 6, "precip": 0,
  "minTemp": 60, "maxTemp": 80, "description": "Clear", "icon": "01d"
}
```

`weatherProvider` from the served `weather.weatherProvider`.

### 5.3 `GET /v1/budget`

Params: `loc` (required), `limit` (optional, default 30, **capped at 90** = `HISTORY_CAP`).

Flow: `resolveCoordinates(loc)`; `state = await getBudgetState(coordinates)` (new export, §6); if no state → `404` `{error:{code:"no_budget_state", …}}`; else shape:

```json
{
  "location": [40.71, -74.0],
  "rainBank": 0.6,
  "lastUpdated": "2024-07-15",
  "lastScale": 80,
  "history": [
    { "date":"2024-07-15", "scale":80, "eto":0.21, "etc":0.19, "effectiveRain":0,
      "rainBankAfter":0.6, "reason":"...", "kc":0.81, "kcSource":"plant" }
  ]
}
```

`history` is the **last `limit`** records (`state.history.slice(-limit)`). `kc`/`kcSource` are included only when present on the record. Lookup resolves `loc` then reads the existing rounded `stateKey` (`coords.toFixed(4)`) — document this so callers know nearby coords map to the same key. `BudgetState` contains no secrets.

---

## 6. Water-Budget state reader

Add to `WaterBudgetAdjustmentMethod.ts` (reusing the private `store`/`stateKey`/`safeGet`):

```ts
export async function getBudgetState( coordinates: GeoCoordinates ): Promise< BudgetState | undefined > {
	return safeGet( stateKey( coordinates ) );
}
```

No write/mutation is exposed. `BudgetState`/`DecisionRecord` types are already exported from `SoilMoistureModel`.

---

## 7. Error model

`sendV1Error( res, err )` maps a `CodedError` (via `makeCodedError`) to an HTTP status + redacted JSON:

| ErrorCode(s) | HTTP | `error.code` |
|---|---|---|
| `InvalidLocationFormat 22`, `NoLocationFound 21`, `MalformedAdjustmentOptions 50`, `MissingAdjustmentOption 51`, `InvalidAdjustmentMethod 41`, `InvalidPwsId 30`, `InvalidPwsApiKey 31`, missing/invalid `method`/`loc` | `400` | `bad_request` |
| `UnsupportedAdjustmentMethod 40` | `422` | `unsupported_method` |
| `LocationServiceApiError 20`, `WeatherApiError 12`, `BadWeatherData 1`, `InsufficientWeatherData 10`, `MissingWeatherField 11`, `PwsAuthenticationError 32`, `NoAPIKeyProvided 35`, `UnexpectedError 99` | `502` | `upstream_error` |
| no budget state | `404` | `no_budget_state` |

`error.message` is `redactLogString(err.message)` or a safe constant per code (never raw provider text with keys). Response body shape: `{ "error": { "code": "...", "message": "..." } }`. No legacy `errCode`/`scale` fields in `/v1` errors.

---

## 8. What's reused vs new / modified

| File | Change |
|------|--------|
| `routes/weather.ts` | **Extract** `computeWateringDecision` (move the decision body out of `getWateringData`; legacy handler calls it and keeps time/sun/eip + legacy formatting); **extract+export** `buildPwsFromParams`; **export** `checkWeatherRestriction`; export the decision types. Legacy handlers refactored to use the shared helpers — behavior preserved. |
| `routes/v1/index.ts` | **New.** Router + `/watering` `/weather` `/budget` handlers, `sendV1Error`, response shapers. |
| `routes/adjustmentMethods/WaterBudgetAdjustmentMethod.ts` | **Add** exported `getBudgetState(coordinates)`. |
| `server.ts` | Register `app.use("/v1", cors(), v1Router)` before the 404 handler. |
| `routes/weather.spec.ts` | Regression test: legacy `getWateringData` output unchanged for one cached + one uncached path (post-extraction). |
| `routes/v1/v1.spec.ts` | **New.** Endpoint tests (below). |
| `docs/v1-api.md` + `README` | **New/updated.** API reference. |

`getWeatherData`'s shape and the legacy formatting are unchanged; only the shared helpers move.

---

## 9. Testing strategy

- **Regression (critical):** before/after the extraction, `getWateringData` returns identical legacy output for (a) a cache-enabled provider path and (b) an uncached path — proves the extraction is behavior-preserving on the firmware hot path. (Reuse the existing route harness/mocks.)
- **`computeWateringDecision`:** with a stub provider — returns the decision object; reflects a fired skip (scale 0 + `skip`/`skipReason`); reflects restriction; `weatherProvider` equals the served `rawData.wp`; invalid method → `CodedError(InvalidAdjustmentMethod)`.
- **`buildPwsFromParams`:** WU + valid pws/key → `{id,apiKey}`; WU + bad pws → `InvalidPwsId`; WU + bad key → `InvalidPwsApiKey`; bare key → `{apiKey}`; nothing → `undefined`.
- **`/v1/watering`:** clean JSON schema; `method` missing/out-of-range → `400`; `restrict=1` sets the restriction; provider failure → `502`. Assert the body has **no** legacy fields (`errCode`/`rd`/`tz`/`sunrise`/`eip`).
- **`/v1/weather`:** conditions JSON; bad `loc` → `400`/`404` mapping.
- **`/v1/budget`:** returns capped history (respects `limit`, cap 90); `404` when no state; `kc`/`kcSource` surfaced when present.
- **Wiring:** `/v1` is registered before the 404 handler (a `/v1/weather` request is not swallowed by 404); CORS header present on `/v1` responses.

---

## 10. Out of scope
- MQTT publishing (next sub-project; consumes `computeWateringDecision` + `getBudgetState`).
- Write/control endpoints, auth tokens, OpenAPI/Swagger generation, the dashboard UI.
- Any change to the legacy response shapes or `getWeatherData` output.

---

## 11. Configuration

No new env vars. `/v1` honors the existing `RATE_LIMIT_MAX`, `WEATHER_PROVIDER`, `WEATHER_PROVIDER_FALLBACKS`, `PWS_FALLBACK_ENABLED`, etc., transitively through the shared compute core and `resolveWeatherProvider`.
