# Firmware Integration Requirements — consuming the OpenSprinkler-Weather contract

> **What this is:** the producer-side specification for the legacy Weather→Firmware request and response contract, verified against the firmware parser (`weather.cpp:getweather_callback`) and guarded by `test/firmware-contract.spec.ts`.

## Actors & boundary
- **Weather service** (this repo): emits the legacy `&key=value` watering response and, optionally, the `/v1` JSON API and MQTT topics.
- **Firmware** (`OpenSprinkler-Firmware`): polls `GET /<method>?loc=&wto=&fwv=` and parses the flat response in `getweather_callback`; the watering scale drives `IOPT_WATER_PERCENTAGE` (station runtime × wl/100).
- **MQTT/HA**: service → broker → Home Assistant. The firmware has its own independent `mqtt.cpp`; the service's MQTT does not target the firmware.

---

## P0 — Frozen legacy request and response contract

**FR-P0.0 — Preserve request method IDs.** The numeric path segment is a public API:

| ID | Weather method |
|---:|---|
| 0 | Manual |
| 1 | Zimmerman |
| 2 | RainDelay |
| 3 | ETo |
| 4 | WaterBudget |

Bit 7 (`0x80`) is the restriction flag and is masked before lookup. Firmware's separate Monthly setting also has internal value 4, but firmware rewrites Monthly to request ID 0 before calling Weather. An incoming Weather request ID 4 therefore always means WaterBudget. The mapping and bit-7 behavior are pinned in `test/firmware-contract.spec.ts`.

**FR-P0.1 — Tolerate new cross-cutting keys.** The firmware parser is key-pull, not schema validation: `getweather_callback` (`weather.cpp:54`) calls `findKeyVal` only for known keys (`errCode/scale/restricted/sunrise/sunset/eip/tz/rd/rawData/scales`). The service's new fields (`skip`, `skipReason`, `pwsBypassed`, `pwsBypassReason`) live **inside the `rawData` JSON blob**, not as top-level keys, and are stored opaquely in `wt_rawData`. **Verified:** unknown content does not break the parser. *Required capability: none new — the existing key-pull parser already satisfies this.*

**FR-P0.2 — Honor `scale=0`.** Weather-skips and the (now-unified) bit-7 rain restriction produce `scale=0`. Firmware accepts `0` (range 0–250), writes `IOPT_WATER_PERCENTAGE=0` (`weather.cpp:72`), and scheduling multiplies by `wl/100` → no station queued (`main.cpp:886/915`). **Verified end-to-end: skip → scale 0 → no watering, no firmware change.**

**FR-P0.3 — Keep the final encoded `rawData` value at most 319 bytes.** With `TMP_BUFFER_SIZE = 320`, `findKeyVal` accepts values through 319 bytes and rejects longer values. `convertToLegacyFormat` measures the value *after* the custom legacy encoding, removes optional reason strings in a fixed order, then uses a compact `{wp,skip,pwsBypassed}` fallback if other fields are still oversized. This must be a UTF-8 byte measurement, not `JSON.stringify(...).length`: `&` expands to `AMPERSAND` on the wire. Combined skip/PWS metadata, non-trimmable oversize, and every adjustment method are covered by the contract guard.

**FR-P0.4 — Emit top-level `restricted=1`.** When the bit-7 restriction fires, Weather emits both `scale=0` and `restricted=1`. Firmware stores this as `wt_restricted`, exposes `wtrestr` in `/jc`, and uses it for skipped-program notifications (`weather.cpp:82`, `main.cpp:887/941`).

**FR-P0.5 — Preserve the final flat encoding.** Legacy responses are `&key=value` fields. Values use the established custom substitutions: space → `+`, newline → the two characters `\\n`, and `&` → `AMPERSAND`. Do not replace this with `URLSearchParams` or `encodeURIComponent`; `formatLegacyWateringData` and its golden test own the exact wire representation.

**FR-P0.6 — Reserve `scales`.** Firmware still parses the top-level `scales` array for 14-day interval adjustments. Normal Weather decisions do not currently produce it, but legacy conversion preserves it when supplied. Do not reuse or silently drop this key without a coordinated firmware decision.

---

## P1 — Optional `/v1` JSON adoption (firmware changes required; non-AVR only)

**NFR-P1.1 — HTTPS/JSON per target.** Non-AVR targets already have TLS (`SUPPORT_HTTPS`: ESP `WiFiClientSecure`, Linux/OSPi `EthernetClientSsl`) and bundle ArduinoJson (used today for `wto`). **AVR has no real TLS** (`https://` is stripped, sends plain HTTP — `weather.cpp:189/227`). **Requirement:** `/v1` adoption is **ESP/Linux-only**; AVR stays on the legacy flat contract.

**FR-P1.2 — JSON response path.** Today weather responses are parsed flat; `/v1` returns JSON. Adoption requires: a JSON client/parser path for the weather response (ArduinoJson is present), URL/param building for `/v1/watering?loc=&method=&restrict=`, mapping `{scale, rainDelay, skip, skipReason, pwsBypassed, weatherProvider, reason}` onto the existing `os` fields, and **HTTP status-code handling** (200 vs 400/404/422/502 + `{error:{code,message}}`) replacing the `errCode` convention.

**FR-P1.2a — `/v1/watering` time-field superset (implemented).** So a single `/v1/watering` call covers the **full** firmware effect-contract (not just the watering decision), the response **additively** carries the OS-encoded time fields the legacy flat response also emitted: `tz` (0–108), `sunrise`/`sunset` (0–1440 local minutes), `eip` (external IP as int). These are encoded identically to the legacy path (`getOsTimeFields` → `getTimezone`/`ipToInt`, `routes/weather.ts`) and shaped by `shapeWateringResponse(decision, time)` (`routes/api/shapers.ts`). Pinned by `test/firmware-contract.spec.ts` ("/v1 watering superset guard") and `routes/v1/v1.spec.ts`. Note: `/v1/weather` stays clean (display-only); the time superset lives only on `/v1/watering`. `scales` is intentionally **not** carried (the service no longer emits multi-day scales). The firmware `/v1` adapter maps `scale→IOPT_WATER_PERCENTAGE`, `rainDelay→rd`, `restricted→wt_restricted`, `tz/sunrise/sunset/eip→` their legacy targets; success/failure derives from HTTP status (no body `errCode`).

**NFR-P1.3 — Response must fit `ETHER_BUFFER`.** HTTP read is capped at `ETHER_BUFFER_SIZE` = 2048 (AVR/ESP) / 16384 (OSPi) (`defines.h:359/474`). `/v1/budget` history can be large → the firmware must request a small `limit=` (or the service must default small). Plain `/v1/watering` + `/v1/weather` fit comfortably.

---

## P2 — MQTT / Home Assistant (no firmware change)

**Confirmed boundary:** the service's retained topics (`<prefix>/<deviceId>/{availability,watering,weather,budget,status}`) + HA discovery + LWT are **service → broker → HA**. The firmware's own `mqtt.cpp` is independent and publishes the controller's state. **No firmware capability required**; do not couple the two MQTT paths.

---

## Edge cases (verified)
- **Weather fetch fails / `errCode != 0`:** only `errCode==0` updates `checkwt_success_lasttime` and applies `scale`/`scales` (`weather.cpp:65`). After a success-timeout, Zimmerman/ETo reset `wl=100` and clear weather state (`main.cpp:1218`); manual/auto-rain-delay/monthly do not. **Edge:** if there was *never* a successful weather call, the timeout-reset path doesn't run — the controller uses its default `wl`. The service's **fail-open** behavior (no scale change when weather is unavailable) is compatible with this.
- **`scales` array (14-day interval scales):** firmware supports `md_scales` (up to 14 days, used for interval programs when `mda==100`) and exposes `wls` in `/jc` (`weather.cpp:141`, `main.cpp:891`). Current decisions do not emit `scales`, so the capability is dormant; the legacy converter preserves the reserved field if supplied. Monthly remains separate (`wto.scales[12]` → `wt_monthly`).
- **`rd` (rain delay):** firmware honors top-level `rd` (`weather.cpp:127`) — start/stop rain delay. The service emits `rd` from the adjustment response; unchanged.

---

## Requirements checklist
- [x] Legacy request IDs 0–4 and bit-7 masking pinned
- [x] Final custom flat-wire encoding pinned
- [x] Final encoded `rawData` kept at or below 319 bytes
- [x] RainDelay included in the cross-method response matrix
- [x] Top-level `restricted` emitted for firmware labeling/notifications
- [x] Reserved `scales` preserved when supplied
- [x] P1 `/v1` adoption capabilities scoped (non-AVR HTTPS+JSON, status codes, buffer fit)
- [x] P2 MQTT boundary confirmed (no firmware change)
- [x] Failsafe/edge behavior characterized

## Out of scope
Firmware refactors; changing adjustment-method math; reviving production `scales`; AVR HTTPS.

## Maintenance
1. Extend `test/firmware-contract.spec.ts` before changing a request ID, top-level key, encoder substitution, or rawData field.
2. Treat `/v1` firmware adoption as a firmware-repository project (non-AVR); keep the legacy path for AVR and rollback compatibility.

---
*Verified against the kars85 firmware parser and maintained by the producer-side contract test.*
