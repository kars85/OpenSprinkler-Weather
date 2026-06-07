# Firmware Integration Requirements — consuming the OpenSprinkler-Weather contract

> **What this is:** a verified specification of exactly what the OpenSprinkler-Firmware must support to consume the OpenSprinkler-Weather service contract as it stands after this session (provider-fallback, per-plant Kc, water-budget Kc, /v1 API, MQTT+HA, rain-restriction consolidation). Produced via integration verification: Claude + Codex read the firmware's actual parser (`weather.cpp:54 getweather_callback`, `main.cpp` scheduler) and confirmed behavior against the service's emitted contract. Analysis/spec only — not implementation.

## Actors & boundary
- **Weather service** (this repo): emits the legacy `&key=value` watering response and, optionally, the `/v1` JSON API and MQTT topics.
- **Firmware** (`C:\Dev\OpenSprinkler-Firmware`): polls `GET /<method>?loc=&wto=&fwv=` and parses the flat response in `getweather_callback`; the watering scale drives `IOPT_WATER_PERCENTAGE` (station runtime × wl/100).
- **MQTT/HA**: service → broker → Home Assistant. The firmware has its own independent `mqtt.cpp`; the service's MQTT does not target the firmware.

---

## P0 — Backward-compatible consumption (verified: works **today, no firmware change required**, with two caveats)

**FR-P0.1 — Tolerate new cross-cutting keys.** The firmware parser is key-pull, not schema validation: `getweather_callback` (`weather.cpp:54`) calls `findKeyVal` only for known keys (`errCode/scale/restricted/sunrise/sunset/eip/tz/rd/rawData/scales`). The service's new fields (`skip`, `skipReason`, `pwsBypassed`, `pwsBypassReason`) live **inside the `rawData` JSON blob**, not as top-level keys, and are stored opaquely in `wt_rawData`. **Verified:** unknown content does not break the parser. *Required capability: none new — the existing key-pull parser already satisfies this.*

**FR-P0.2 — Honor `scale=0`.** Weather-skips and the (now-unified) bit-7 rain restriction produce `scale=0`. Firmware accepts `0` (range 0–250), writes `IOPT_WATER_PERCENTAGE=0` (`weather.cpp:72`), and scheduling multiplies by `wl/100` → no station queued (`main.cpp:886/915`). **Verified end-to-end: skip → scale 0 → no watering, no firmware change.**

**⚠️ FR-P0.3 (REAL RISK — weather-service side) — `rawData` ≤ 319 bytes.** `findKeyVal` truncates/ignores a `rawData` value longer than `TMP_BUFFER_SIZE-1 = 319` bytes (`defines.h:31`). The new `skip`/`skipReason`/`pwsBypassed` fields **increase** the serialized `rawData` size. **Requirement (on the weather service, not firmware):** keep the legacy `rawData` payload compact — short `skipReason`/`pwsBypassReason` strings, and verify total serialized `rawData` stays < 319 bytes for every method, or the firmware silently drops the entire `rawData`. *This is the single most actionable integration finding; add a length guard/test on `convertToLegacyFormat` output.*

**⚠️ FR-P0.4 (GAP — restriction labeling) — emit top-level `restricted`.** The firmware has a real, wired restriction mechanism: `wt_restricted` (top-level `restricted` key) forces `wl=0` for weather programs, is exposed as `wtrestr` in `/jc`, and drives skipped-program **notifications** (`weather.cpp:82`, `main.cpp:887/941`). The service **never emits `restricted`**, so our restriction reaches the controller only as `scale=0` — watering still skips, **but the firmware/app cannot label or notify it as a restriction**. *Optional weather-service enhancement (lights up an existing firmware capability with zero firmware change): emit top-level `restricted=1` when the bit-7/rain restriction fires, in addition to `scale=0`.*

---

## P1 — Optional `/v1` JSON adoption (firmware changes required; non-AVR only)

**NFR-P1.1 — HTTPS/JSON per target.** Non-AVR targets already have TLS (`SUPPORT_HTTPS`: ESP `WiFiClientSecure`, Linux/OSPi `EthernetClientSsl`) and bundle ArduinoJson (used today for `wto`). **AVR has no real TLS** (`https://` is stripped, sends plain HTTP — `weather.cpp:189/227`). **Requirement:** `/v1` adoption is **ESP/Linux-only**; AVR stays on the legacy flat contract.

**FR-P1.2 — JSON response path.** Today weather responses are parsed flat; `/v1` returns JSON. Adoption requires: a JSON client/parser path for the weather response (ArduinoJson is present), URL/param building for `/v1/watering?loc=&method=&restrict=`, mapping `{scale, rainDelay, skip, skipReason, pwsBypassed, weatherProvider, reason}` onto the existing `os` fields, and **HTTP status-code handling** (200 vs 400/404/422/502 + `{error:{code,message}}`) replacing the `errCode` convention.

**NFR-P1.3 — Response must fit `ETHER_BUFFER`.** HTTP read is capped at `ETHER_BUFFER_SIZE` = 2048 (AVR/ESP) / 16384 (OSPi) (`defines.h:359/474`). `/v1/budget` history can be large → the firmware must request a small `limit=` (or the service must default small). Plain `/v1/watering` + `/v1/weather` fit comfortably.

---

## P2 — MQTT / Home Assistant (no firmware change)

**Confirmed boundary:** the service's retained topics (`<prefix>/<deviceId>/{availability,watering,weather,budget,status}`) + HA discovery + LWT are **service → broker → HA**. The firmware's own `mqtt.cpp` is independent and publishes the controller's state. **No firmware capability required**; do not couple the two MQTT paths.

---

## Edge cases (verified)
- **Weather fetch fails / `errCode != 0`:** only `errCode==0` updates `checkwt_success_lasttime` and applies `scale`/`scales` (`weather.cpp:65`). After a success-timeout, Zimmerman/ETo reset `wl=100` and clear weather state (`main.cpp:1218`); manual/auto-rain-delay/monthly do not. **Edge:** if there was *never* a successful weather call, the timeout-reset path doesn't run — the controller uses its default `wl`. The service's **fail-open** behavior (no scale change when weather is unavailable) is compatible with this.
- **`scales` array (14-day interval scales):** firmware supports `md_scales` (up to 14 days, used for interval programs when `mda==100`) and exposes `wls` in `/jc` (`weather.cpp:141`, `main.cpp:891`). The service does **not** emit `scales` → this firmware capability is **dormant**, not broken. (Monthly is separate: `wto.scales[12]` → `wt_monthly`.)
- **`rd` (rain delay):** firmware honors top-level `rd` (`weather.cpp:127`) — start/stop rain delay. The service emits `rd` from the adjustment response; unchanged.

---

## Requirements checklist
- [x] P0 backward-compat **verified** against the real parser (no firmware change for skip/scale-0/new keys)
- [x] P0 risk identified: `rawData` 320-byte truncation (weather-service-side length guard needed)
- [x] P0 gap identified: emit top-level `restricted` to light up firmware restriction labeling/notifications
- [x] P1 `/v1` adoption capabilities scoped (non-AVR HTTPS+JSON, status codes, buffer fit)
- [x] P2 MQTT boundary confirmed (no firmware change)
- [x] Failsafe/edge behavior characterized

## Out of scope
Implementation; firmware refactors (see `firmware-definition.md`); changing the adjustment-method math; multi-zone `scales` revival; AVR HTTPS.

## Recommended next actions (weather-service side, low-risk)
1. **Add a `rawData` length guard + test** in `convertToLegacyFormat` (assert serialized `rawData` < 319 bytes; trim `skipReason`/`pwsBypassReason` if needed) — protects every legacy client (FR-P0.3).
2. **Optionally emit top-level `restricted=1`** when the restriction fires, so the firmware labels/notifies it (FR-P0.4).
3. Treat `/v1` firmware adoption as a **firmware-repo** project (non-AVR), using the seam from `firmware-definition.md`.

---
*Integration verification + spec — 🔴 Codex (firmware code-grounded, adversarial completeness) · 🔵 Claude (parser verification + synthesis). Firmware refs at `C:\Dev\OpenSprinkler-Firmware`.*
