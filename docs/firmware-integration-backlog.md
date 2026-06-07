# Firmware integration backlog (coupling tracker)

> Tracks the firmware-side work implied by the OpenSprinkler-Weather contract. **Issues are disabled on `kars85/OpenSprinkler-Firmware`**, so these are drafted here (in the producer repo, next to the contract spec) — copy into the firmware tracker if/when enabled. Source of truth: [`firmware-integration-requirements.md`](firmware-integration-requirements.md).

---

## FW-1 (P1) — Adopt the `/v1` JSON weather API (non-AVR) behind a `WeatherContract` seam
The weather service now exposes versioned `GET /v1/watering|/weather|/budget` (clean JSON, HTTP status errors) — the explicit, evolvable contract vs. the implicit legacy flat format.

- **Scope (non-AVR only):** a JSON response path (ArduinoJson already bundled for `wto`), URL/param building, HTTP status-code handling (200 vs 400/404/422/502 + `{error:{code,message}}`) replacing `errCode`.
- **AVR out of scope** — no real TLS (`weather.cpp:189/227`); AVR keeps the legacy flat contract.
- Response must fit `ETHER_BUFFER_SIZE` (2048 on ESP) → request a small `/v1/budget?limit=`.
- **Approach:** the `WeatherContract`/`WeatherResult` seam from `OpenSprinkler-Firmware/docs/firmware-definition.md` (Phase 1) — flat parser and `/v1` JSON parser as interchangeable adapters.
- **Done when:** a non-AVR build fetches+parses `/v1/watering` and applies scale/rainDelay/skip identically to the legacy path; legacy remains default/fallback; AVR unaffected.

## FW-2 (P0, verify — likely no code change) — Confirm top-level `restricted` end-to-end
The service now emits top-level `restricted=1` when its restriction fires (was `scale=0` only). The firmware **already** parses it into `wt_restricted` (`weather.cpp:82`) → forces `wl=0`, exposes `wtrestr` in `/jc` (`opensprinkler_server.cpp:1273`), drives skipped-program notifications (`main.cpp:887/941`).

- **Task:** verify that when the service restricts, the firmware now sets `wt_restricted` and the notification + `wtrestr` reflect it (previously silent). Add a note/test so it doesn't regress.

## FW-3 (process) — Track the contract as a versioned, cross-linked artifact
The boundary is now a frozen, additive-only, size-bounded public API guarded by `test/firmware-contract.spec.ts` here.

- **Task (firmware side):** add `docs/weather-contract.md` cross-linking this repo's `firmware-integration-requirements.md`; document the firmware constraints the producer must respect — `rawData` < 319 bytes (`TMP_BUFFER_SIZE`, `defines.h:31`), `ETHER_BUFFER_SIZE` cap, AVR no-TLS; decide keep-or-retire the dormant `scales` (14-day `md_scales`) capability the service no longer emits.
- **Outcome:** changes on either side are coordinated, not discovered in the field.

---

## How the coupling is managed (summary)
1. **Producer owns the contract.** This repo's `firmware-integration-requirements.md` is the canonical wire-format spec.
2. **Legacy = frozen public API** (additive-only, size-bounded) — enforced by `test/firmware-contract.spec.ts` in CI.
3. **`/v1` = forward path**, adopted incrementally by the firmware (non-AVR) behind the `WeatherContract` seam.
4. **Cross-repo work is tracked here** (issues disabled upstream) and mirrored into the firmware repo's docs.
