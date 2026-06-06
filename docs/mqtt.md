# MQTT Publishing (+ Home Assistant)

When `MQTT_BROKER_URL` is set, the service connects to your MQTT broker and periodically
publishes your site's watering decision, weather, and Water-Budget state as **retained**
topics, and emits **Home Assistant MQTT discovery** so HA auto-creates entities. It is
**off by default** — nothing connects until you configure a broker.

## Configuration (environment variables)

| Var | Default | Meaning |
|---|---|---|
| `MQTT_BROKER_URL` | — | Enables publishing, e.g. `mqtt://192.168.1.10:1883`. |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | — | Optional broker auth. |
| `MQTT_LOCATION` | — | Your site location (`lat,lon` or a geocodable string). Required. |
| `MQTT_METHOD` | 4 | Adjustment method (0 manual, 1 zimmerman, 2 rainDelay, 3 eto, 4 waterBudget). |
| `MQTT_RESTRICT` | 0 | `1` applies the rain restriction. |
| `MQTT_PROVIDER` / `MQTT_PWS` / `MQTT_KEY` | — | Optional provider / personal weather station. |
| `MQTT_TOPIC_PREFIX` | `opensprinkler-weather` | State/availability/status topic prefix. |
| `MQTT_DISCOVERY_PREFIX` | `homeassistant` | HA discovery prefix. |
| `MQTT_DEVICE_ID` | `osw` | Device id (`[A-Za-z0-9_-]`). |
| `MQTT_INTERVAL_MINUTES` | 30 | Publish interval. |

## Topics

- `<prefix>/<deviceId>/availability` — `online`/`offline` (retained; LWT).
- `<prefix>/<deviceId>/watering` — watering decision JSON (retained).
- `<prefix>/<deviceId>/weather` — current conditions JSON (retained).
- `<prefix>/<deviceId>/budget` — Water-Budget JSON (retained; only once budget state exists).
- `<prefix>/<deviceId>/status` — `{ ok, errorCode?, lastError? }` diagnostics (retained).

## Home Assistant

With discovery enabled (default), HA auto-creates sensors (watering scale, rain delay,
weather, rain bank, etc.) and a binary sensor for "watering skip", all under one device.
No manual sensor config needed — just point the service at the same broker HA uses.

## Notes

- Watering follows the same daily cache as the HTTP API; weather is fetched fresh each interval.
- `MQTT_RESTRICT=1` force-enables the rain skip for the published decision (same `RAIN_SKIP`
  threshold, live + fail-open), equivalent to the firmware restriction bit.
- A weather/compute failure for one section leaves that topic's last retained value intact and
  sets `status.ok=false`; the broker availability stays `online` (it reflects only the connection).
- Credentials and API keys are never published or included in discovery, and are redacted in logs.
