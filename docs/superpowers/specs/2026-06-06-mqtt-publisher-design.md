# MQTT Publisher (+ Home Assistant Discovery) — Design Spec

**Date:** 2026-06-06
**Status:** Approved for planning (pending user read-through)
**Feature:** An opt-in MQTT publisher that periodically pushes the configured site's watering decision, weather, and Water-Budget state to an MQTT broker as retained topics, with Home Assistant MQTT discovery so HA auto-creates entities. Second sub-project of the smart-home integration; consumes the `/v1` data layer.

---

## 1. Problem & Goal

The server can compute a watering decision, weather, and budget state (the `/v1` layer: `computeWateringDecision`, `resolveWeatherProvider().getWeatherData`, `getBudgetState`), but only when polled over HTTP. Smart-home users want this state **pushed** to their MQTT broker so Home Assistant (and Node-RED, etc.) always have fresh, retained state and auto-created entities — without polling the HTTP API.

**Goal:** an opt-in background publisher that, on a timer, publishes the configured site's state to retained MQTT topics and emits HA discovery configs. **Zero behavior change when disabled.**

**Scope:** publish + HA discovery for a single operator-configured site. Out of scope: command/control (subscribe), multiple sites, non-HA discovery schemas, TLS client-cert auth.

---

## 2. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| D1 | **Opt-in** | Active only when `MQTT_BROKER_URL` is set; the publisher module is required/started only in that branch (no behavior, no `mqtt` load, when unset). |
| D2 | **Trigger** | On connect + every `MQTT_INTERVAL_MINUTES` (default 30) via `setInterval`. |
| D3 | **Site** | Single configured site (`MQTT_LOCATION` + method/options via env). |
| D4 | **Data source** | The `/v1` compute/read layer + the **shapers extracted to a pure module** `routes/api/shapers.ts` (no Express/route dependency from MQTT). |
| D5 | **Discovery** | Home Assistant MQTT discovery configs (retained), plus retained state topics + LWT availability. |

---

## 3. Architecture

- **`routes/api/shapers.ts`** (NEW, pure) — `shapeWateringResponse`, `shapeWeatherResponse`, `shapeBudgetResponse` moved here from `routes/v1/index.ts`; `/v1` re-imports them (behavior-preserving — `/v1` tests unchanged). MQTT imports from here, never from the router.
- **`mqtt/payloads.ts`** (NEW, pure) — `buildStatePayloads(...)` and `buildDiscoveryConfigs(...)`. No I/O; fully unit-testable.
- **`mqtt/MqttPublisher.ts`** (NEW, I/O) — connection (LWT), the interval loop, gathering state from the compute/read layer, and publishing. Accepts an **injected mqtt client (or client factory)** so tests use a fake; the data-gather is a small internal function using the shared layer.
- **`mqtt/config.ts`** (NEW, pure) — `resolveMqttConfig(env): MqttConfig | null` (null when `MQTT_BROKER_URL` unset).
- **`server.ts`** — after `app.listen`, `if (process.env.MQTT_BROKER_URL) { require("./mqtt/MqttPublisher").startMqttPublisher(); }` (guarded require — D1/#8).

```
setInterval tick ─▶ gatherState() ─▶ buildStatePayloads() ─▶ client.publish(retained)
   on connect    ─▶ buildDiscoveryConfigs() + "online" (retained) ─▶ publish
   LWT           ─▶ availability "offline" (retained) set at connect
```

---

## 4. Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `MQTT_BROKER_URL` | unset | Enables the publisher (e.g. `mqtt://host:1883`). |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | unset | Optional broker auth. |
| `MQTT_LOCATION` | unset | The site `loc` (lat,lon or geocodable). **Required when enabled** — if missing, log a clear warning and stay idle. |
| `MQTT_METHOD` | `4` | Adjustment method id (0–4). |
| `MQTT_RESTRICT` | `0` | `1` sets the rain-restriction bit (mirrors `/v1/watering`). |
| `MQTT_PROVIDER` / `MQTT_PWS` / `MQTT_KEY` | unset | Optional provider/PWS selection. |
| `MQTT_TOPIC_PREFIX` | `opensprinkler-weather` | State/availability/status topic prefix. |
| `MQTT_DISCOVERY_PREFIX` | `homeassistant` | HA discovery prefix. |
| `MQTT_DEVICE_ID` | `osw` | Device id used in topics + entity `unique_id`s. |
| `MQTT_INTERVAL_MINUTES` | `30` | Publish interval. |

`adjustmentParam = MQTT_METHOD | (MQTT_RESTRICT ? (1<<7) : 0)`.

**Secret hygiene (#9):** broker URL credentials, `MQTT_PASSWORD`, `MQTT_KEY`, and provider keys are **never** placed in any published payload or discovery config, and are redacted in logs via `redactLogValue`/`redactLogString`.

---

## 5. Topics & retain policy

| Topic | Retain | Payload |
|---|---|---|
| `<prefix>/<deviceId>/availability` | **yes** | `online` / `offline` (LWT = `offline`; `online` published on connect) |
| `<prefix>/<deviceId>/watering` | yes | watering JSON (`shapeWateringResponse`) |
| `<prefix>/<deviceId>/weather` | yes | weather JSON (`shapeWeatherResponse`) |
| `<prefix>/<deviceId>/budget` | yes | budget JSON (`shapeBudgetResponse`) — **only published when budget state exists** (#2) |
| `<prefix>/<deviceId>/status` | yes | `{ "ok": true|false, "errorCode": <n>?, "lastError": "<redacted>"? }` (#5) |
| `<discoveryPrefix>/<component>/<deviceId>_<entity>/config` | yes | HA discovery config (published once on connect) |

---

## 6. Data gathering & failure behavior (#4, #5)

Each tick, `gatherState()` collects three sections **independently** (a failure in one never blocks the others or overwrites a good retained topic):

1. **watering:** `computeWateringDecision({ coordinates, adjustmentParam, adjustmentOptions, pws })` → `shapeWateringResponse`. Follows the **same cache behavior as `/v1`/legacy** (cache-enabled providers may return the day's cached scale; not a forced fresh calc each interval).
2. **weather:** `resolveWeatherProvider(adjustmentOptions, pws).getWeatherData(coordinates, pws)` → `shapeWeatherResponse`. **Fresh each tick.**
3. **budget:** `getBudgetState(coordinates)` → if present, `shapeBudgetResponse`; if absent (method ≠ 4, or first boot before any HTTP-driven calc), **skip the budget topic**.

Publishing rules:
- Publish only the sections that succeeded this tick. A section that throws is logged (redacted) and its **retained topic is left unchanged** — no error payload overwrites good state.
- After the tick, publish `status`: `{ ok: allSucceeded, errorCode?, lastError? }`.
- **Availability is independent of compute health:** it reflects only the broker connection (LWT/connect). A failed weather fetch does **not** flip availability to `offline`.
- `coordinates` is resolved once per tick from `MQTT_LOCATION` (a resolve failure makes the whole tick a no-op + `status.ok=false`).

---

## 7. Home Assistant discovery entities (#6)

One shared `device` block (`identifiers:[deviceId]`, `name`, `manufacturer:"OpenSprinkler-Weather"`) and shared availability on every entity: `availability_topic: <prefix>/<deviceId>/availability`, `payload_available:"online"`, `payload_not_available:"offline"`. Each entity has a stable `unique_id` (`<deviceId>_<entity>`), `name`, `state_topic`, and `value_template`.

| entity | component | state_topic | value_template | device_class / state_class / unit |
|---|---|---|---|---|
| `watering_scale` | sensor | …/watering | `{{ value_json.scale }}` | state_class measurement, unit `%` |
| `rain_delay` | sensor | …/watering | `{{ value_json.rainDelay }}` | unit `h` |
| `watering_skip` | binary_sensor | …/watering | `{{ 'ON' if value_json.skip else 'OFF' }}` | payload_on `ON`, payload_off `OFF` |
| `watering_reason` | sensor | …/watering | `{{ value_json.reason }}` | (text) |
| `weather_provider` | sensor | …/watering | `{{ value_json.weatherProvider }}` | (text) |
| `temperature` | sensor | …/weather | `{{ value_json.temp }}` | device_class temperature, state_class measurement, unit `°F` |
| `humidity` | sensor | …/weather | `{{ value_json.humidity }}` | device_class humidity, state_class measurement, unit `%` |
| `wind` | sensor | …/weather | `{{ value_json.wind }}` | device_class wind_speed, unit `mph` |
| `precip` | sensor | …/weather | `{{ value_json.precip }}` | device_class precipitation, unit `in` |
| `rain_bank` | sensor | …/budget | `{{ value_json.rainBank \| default('') }}` | unit `in` — tolerates missing budget (unknown until first budget publish) (#2) |

Discovery is published **once on connect** (retained). `value_template`s read JSON via `value_json`. Text sensors are plain `sensor` with string templates; `watering_skip` is a `binary_sensor`.

---

## 8. Pure builders (testable)

- `buildStatePayloads(deviceId, prefix, state): Array<{ topic, payload, retain:true }>` — given `{ watering, weather, budget|null, status }`, returns the topics to publish (omits `budget` when null). `payload` is JSON-stringified.
- `buildDiscoveryConfigs(deviceId, prefix, discoveryPrefix): Array<{ topic, payload, retain:true }>` — the entity table above as discovery topics + config objects.

The publisher calls these and pushes each via the injected client; the builders contain no I/O.

---

## 9. Resilience (#5, #8)

- The `mqtt` client is created with `{ username, password, will: { topic: availability, payload: "offline", retain: true, qos: 0 } }`; it auto-reconnects.
- On `connect`: publish discovery (retained), publish `online` (retained), run an immediate tick.
- Compute/publish errors are caught and logged (redacted); they never crash the process and never overwrite a good retained topic.
- When `MQTT_BROKER_URL` is unset, the publisher module is never required/loaded — the HTTP server is byte-for-byte unchanged.
- On process shutdown (SIGTERM/SIGINT), best-effort publish `offline` + `client.end()` (graceful; optional, non-blocking).

---

## 10. Affected files

| File | Change |
|------|--------|
| `routes/api/shapers.ts` | **New.** Pure `shapeWateringResponse`/`shapeWeatherResponse`/`shapeBudgetResponse` (moved from `routes/v1/index.ts`). |
| `routes/v1/index.ts` | Import the shapers from `../api/shapers` (no behavior change). |
| `mqtt/config.ts` | **New.** `resolveMqttConfig(env)`. |
| `mqtt/payloads.ts` | **New.** `buildStatePayloads`, `buildDiscoveryConfigs`. |
| `mqtt/MqttPublisher.ts` | **New.** `startMqttPublisher()` + injectable internals (gather + publish loop + connection). |
| `mqtt/payloads.spec.ts`, `mqtt/MqttPublisher.spec.ts` | **New.** Pure builder tests + publisher test with a fake client. |
| `server.ts` | Guarded start of the publisher when `MQTT_BROKER_URL` is set. |
| `package.json` / `package-lock.json` | Add `mqtt` dependency. |
| `docs/mqtt.md` + `README` | Operator + HA setup guide. |

---

## 11. Testing strategy

- **`resolveMqttConfig`:** null when `MQTT_BROKER_URL` unset; parses defaults + overrides; `adjustmentParam` reflects `MQTT_RESTRICT`.
- **`buildDiscoveryConfigs`:** emits one config per entity at the right discovery topic with `unique_id`, `state_topic`, `value_template`, shared `device` + `availability_topic`; `watering_skip` is a `binary_sensor` with ON/OFF.
- **`buildStatePayloads`:** maps a gathered state to watering/weather/status topics (retained, JSON); **omits budget when budget is null**; includes budget when present.
- **`MqttPublisher` with a fake client:** on connect → publishes discovery + `online`; on tick → publishes state + status; a compute failure for one section → that topic is NOT published and `status.ok=false`, others still publish; availability stays `online`; LWT is configured `offline` retained. (No real broker; inject the fake.)
- **Secret hygiene:** no payload/discovery string contains the password/key (assert on the built payloads).

---

## 12. Out of scope
- Command/control (MQTT subscribe to set values), multiple sites, non-HA discovery, TLS client certs.
- Changes to the `/v1` HTTP behavior, the compute/read layer, or legacy responses (the shaper move is behavior-preserving).
