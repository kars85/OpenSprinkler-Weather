# Weather Skips (Freeze / Wind / Rain)

Three optional guards can force watering to **0%** when conditions make watering
wasteful or risky. They apply to **every** adjustment method and are evaluated
**live on each request** (independent of the daily watering-scale cache).

All three are **off by default** — nothing changes until you enable one.

## Enable / configure (environment variables)

| Guard | Enable | Threshold | Default threshold |
|---|---|---|---|
| Freeze | `SKIP_FREEZE` | `FREEZE_TEMP` | 32 (F) |
| Wind | `SKIP_WIND` | `WIND_MAX` | 25 (mph) |
| Rain | `SKIP_RAIN` | `RAIN_SKIP` | 0.1 (in) |
| (memo) | `SKIP_WEATHER_TTL` | — | 600000 ms (10 min) |

Enable flags accept only `true`, `1`, `yes`, or `on` (case-insensitive); any other
value leaves the guard off. A threshold alone never enables a guard. Each guard can
also be overridden per request via `wto` options: `skipFreeze` / `skipFreezeTemp`,
`skipWind` / `skipWindMax`, `skipRain` / `skipRainThreshold`.

## Behavior

- **Freeze:** skips when the forecast minimum temperature (or current temperature, for
  local/PWS sources that do not report a minimum) is at or below `FREEZE_TEMP`.
- **Wind:** skips when wind speed is at or above `WIND_MAX`.
- **Rain:** skips when the provider's reported precipitation for the current window is at
  or above `RAIN_SKIP`. This is "today already looks wet enough", not a live raindrop
  sensor (the controller's own rain sensor handles real-time rain).

When a guard fires, the response sets `scale = 0` and adds `rawData.skip = 1` and a
human-readable `rawData.skipReason` (e.g. `freeze: 28F at or below 32F`). If weather data
is unavailable, the guards do nothing (watering proceeds) — they never block on missing data.
