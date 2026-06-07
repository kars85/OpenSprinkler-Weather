# `/v1` JSON API

A versioned, read-only JSON API for smart-home integrations and dashboards. All endpoints
accept `loc` (a `lat,lon` pair or a geocodable location string) and return JSON. Errors use
HTTP status codes with a `{ "error": { "code", "message" } }` body.

## `GET /v1/watering`

Returns the same watering decision the firmware would receive, as clean JSON.

Query: `loc` (required), `method` (required, integer 0–4: 0 manual, 1 zimmerman, 2 rainDelay,
3 eto, 4 waterBudget), `provider`, `pws`, `key` (optional).

`restrict` (optional `1`/`true`) — force-enables the rain skip (skip watering when recent precip
≥ `RAIN_SKIP`, default 0.1in), evaluated live and fail-open. Equivalent to the firmware's rain
restriction bit. When it fires, the response has `skip: true` + a rain `skipReason`.

```json
{ "location":[42.37,-72.52], "method":"waterBudget", "methodId":4, "scale":80,
  "rainDelay":0, "skip":false, "skipReason":null, "pwsBypassed":false,
  "weatherProvider":"OWM", "reason":"Scale 80%: ...", "raw":{ } }
```

## `GET /v1/weather`

Current conditions. Query: `loc` (required), `provider`/`pws`/`key` (optional).

```json
{ "location":[42.37,-72.52], "weatherProvider":"OWM", "temp":72, "humidity":55,
  "wind":6, "precip":0, "minTemp":60, "maxTemp":80, "description":"clear sky", "icon":"01d" }
```

## `GET /v1/budget`

Persisted Water-Budget insight (rain bank + recent decisions). Query: `loc` (required),
`limit` (optional, default 30, max 90). Returns `404` if no state exists for the location yet.
Lookup resolves `loc` then matches the stored state key (coordinates rounded to 4 decimals),
so nearby coordinates map to the same record.

```json
{ "location":[42.37,-72.52], "rainBank":0.6, "lastUpdated":"2024-07-15", "lastScale":80,
  "history":[ { "date":"2024-07-15", "scale":80, "eto":0.21, "etc":0.19, "effectiveRain":0,
               "rainBankAfter":0.6, "reason":"...", "kc":0.81, "kcSource":"plant" } ] }
```

## Errors

| Status | When |
|---|---|
| 400 | missing/invalid `loc` or `method`, bad PWS id/key, malformed options |
| 404 | `/v1/budget` with no stored state |
| 422 | the weather provider does not support the requested method |
| 502 | upstream weather/geocoder failure |

No authentication; the global rate limit applies.
