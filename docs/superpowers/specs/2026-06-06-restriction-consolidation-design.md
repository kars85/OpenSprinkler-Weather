# Rain-Restriction Consolidation — Design Spec

**Date:** 2026-06-06
**Status:** Approved for planning (pending user read-through)
**Feature:** Collapse the two near-identical precip-restriction implementations into one. The firmware restriction bit (bit 7 / `/v1` `restrict`) becomes a **compatibility alias** that force-enables the weather-skips rain rule, and the standalone `checkWeatherRestriction` is removed.

---

## 1. Problem

There are two precip → `scale 0` rules in this repo:

- **California restriction** — `checkWeatherRestriction` (`routes/weather.ts`), gated by adjustment-param **bit 7**, `precip > 0.1` (hardcoded, strict), reads the *method's* `wateringData`, silent, evaluated before the cache store.
- **Rain skip** — the weather-skips engine, opt-in (`SKIP_RAIN`/`skipRain`), `precip >= threshold` (configurable, inclusive), reads `getWeatherData`, emits a reason, evaluated live in the `applyWeatherSkips` overlay.

These are the same rule twice. Calendar restrictions (even/odd, day-of-week, monthly) are **out of scope** — the OpenSprinkler firmware already owns them per-program (`program.h`: `oddeven`, `type`, `days[]`), and the weather service returns a single global scale that can't express them.

**Goal:** one rain decision path, one reason format. Bit 7 / `restrict=1` ⇒ "rain skip on."

---

## 2. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| D1 | **Unify via forceRain** | Bit 7 (`checkRestrictions`) is passed into the skip overlay as `forceRain`; the skips engine evaluates rain. |
| D2 | **Remove `checkWeatherRestriction`** | Delete the function + its export + the "fetch wateringData for restriction" path in `computeWateringDecision`. |
| D3 | **Threshold precedence** | `skipRainThreshold` (wto) → `RAIN_SKIP` (env) → `0.1`. |
| D4 | **Force semantics** | `forceRain` enables rain **even if `skipRain=false`**; an already-enabled rain config (incl. its threshold) **wins untouched** — force only fills a *missing* rain rule. |
| D5 | **Scope** | Dedup only. No calendar restrictions, no change to non-rain skip behavior. |

---

## 3. Changes

### `routes/skips/WeatherSkips.ts`
`resolveSkipConfig(adjustmentOptions, env = process.env, forceRain = false)`: after the existing rain resolution, add:

```ts
if ( forceRain && !cfg.rain ) cfg.rain = { threshold: value( "skipRainThreshold", "RAIN_SKIP", 0.1 ) };
```

(`value()` is the existing wto→env→default helper, so D3 precedence and D4 "already-enabled wins" both hold — the line only runs when `cfg.rain` is unset, and it ignores the `skipRain` enable flag.)

### `routes/skips/SkipGuard.ts`
`applyWeatherSkips(dataToSend, weatherProvider, coordinates, pws, adjustmentOptions, now = Date.now(), forceRain = false)`: pass `forceRain` to `resolveSkipConfig(adjustmentOptions || {}, process.env, forceRain)`. (`forceRain` added as a trailing param so the existing `now` positional in tests is unaffected.)

### `routes/weather.ts` — `computeWateringDecision`
- **Remove** the `if ( checkRestrictions ) { ... checkWeatherRestriction ... }` block and the "fetch `wateringData` for restriction" path.
- **Keep** computing `checkRestrictions` from `adjustmentParam` (`((adjustmentParam >> 7) & 1) > 0`).
- Change the overlay call to:
  ```ts
  decision = await applyWeatherSkips( decision, weatherProvider, coordinates, pws, adjustmentOptions, undefined, checkRestrictions );
  ```
- **Delete** `checkWeatherRestriction` and its `export`; drop the now-unused `BaseWateringData` import if nothing else uses it.

The cache store still happens before the overlay and stores the **unrestricted** method result; the rain decision is applied live by the overlay (see §4).

---

## 4. Cache semantics (the biggest behavior change)

**Before:** the restriction ran on a cache **miss**, set `scale = 0`, and that restricted `0` was stored under the bit-7 cache key. A same-day cache hit returned the stored `0`.

**After:** the cache stores the **method result before any rain decision**; the rain restriction is evaluated **live in `applyWeatherSkips` on every request — cache hit or miss**. This makes the restriction live (it reflects current precip even on a cached day), which is the desirable behavior and consistent with how skips already work.

**Cache key:** `adjustmentParam` (including bit 7) is still used for `cache.getWateringScale`/`storeWateringScale`. Restricted vs unrestricted requests therefore keep **separate cache entries**, even though the cached pre-overlay method result is now identical. This is behavior-preserving and low-risk; **intentionally kept as-is** for this small change.

---

## 5. Legacy behavior change (firmware-facing)

When weather can't be evaluated, the rain restriction now **fails open** (watering proceeds) instead of returning an error:

- **Before:** if the restriction needed `wateringData` and the provider fetch failed, `getWateringData` returned an **error response**.
- **After:** the skip overlay fetches `getWeatherData` fail-open (via the skip memo); if it's unavailable, **no rain restriction is applied and watering proceeds** — matching the weather-skips philosophy.

Other intentional changes for the restriction path: precip source is now `getWeatherData` (not the method's `wateringData`); the boundary is `>= threshold` (inclusive) rather than `> 0.1` (differs only at exactly the threshold); the threshold is configurable (`RAIN_SKIP`, default 0.1); and the restriction now emits `rawData.skip`/`skipReason` (was silent).

---

## 6. Testing strategy

- **`resolveSkipConfig` force:** `forceRain=true` with no rain config ⇒ `rain` enabled at `value()` threshold; with `skipRain=false` ⇒ force still enables rain (D4); with rain already enabled (`SKIP_RAIN`/`skipRain` + a custom threshold) ⇒ that config is **unchanged** (force does not override it); threshold precedence `skipRainThreshold` → `RAIN_SKIP` → `0.1` (D3).
- **`applyWeatherSkips` force:** with `forceRain=true`, a wet day ⇒ `scale 0` + rain `skipReason`; a dry day ⇒ input unchanged; weather unavailable ⇒ input unchanged (fail-open).
- **`computeWateringDecision`:** with the restriction bit set, a wet day yields the rain skip via the unified path (`skip`/`skipReason` present, scale 0); without the bit and no `SKIP_*`, no skip.
- **Cache-hit liveness:** a restricted request caches a **dry** method result; then (via the skip-memo `now` controls / `__clearSkipWeatherMemo`) skip-weather becomes **wet**; a second restricted request applies the rain skip on the cached method result (`scale 0`) — proving the live overlay over the cache.
- **Legacy regression:** the existing "Watering Data" suite stays green (it doesn't set bit 7, so legacy output is unchanged).
- **`/v1/watering?...&restrict=1`:** confirms the end-to-end unified behavior (rain skip applied; clean schema).

---

## 7. Affected files

| File | Change |
|------|--------|
| `routes/skips/WeatherSkips.ts` | `resolveSkipConfig` gains `forceRain` (fills a missing rain rule). |
| `routes/skips/SkipGuard.ts` | `applyWeatherSkips` gains a trailing `forceRain` param, threaded to `resolveSkipConfig`. |
| `routes/weather.ts` | `computeWateringDecision`: remove `checkWeatherRestriction` + restriction-fetch; pass `forceRain = checkRestrictions` to the overlay; delete `checkWeatherRestriction` + export. |
| `routes/skips/WeatherSkips.spec.ts`, `routes/skips/SkipGuard.spec.ts`, `routes/weather.spec.ts` | Add force-rain + cache-hit-liveness + `/v1 restrict` tests. |
| `docs/weather-skips.md`, `docs/v1-api.md`, `docs/mqtt.md`, `README.md` | Update text: the restriction bit / `restrict=1` **force-enables the rain skip** (one rain path); document the fail-open + live-overlay + threshold behavior. |

(Historical `docs/superpowers/specs|plans/*` are point-in-time records and are left as-is.)

---

## 8. Out of scope
- Calendar restrictions (even/odd, day-of-week, monthly/seasonal) — firmware-owned (`program.h`).
- Changing non-rain skip behavior (freeze/wind), the cache key scheme, or any adjustment-method math.
- New restriction types or a generalized restriction "engine".
