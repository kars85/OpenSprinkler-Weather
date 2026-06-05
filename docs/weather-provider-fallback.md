# Weather Provider Fallback

When the active weather provider fails with a **transient** error (API down, timeout,
malformed/insufficient data) or cannot service the requested method, the service can
**fall through** to the next provider in a configured chain instead of returning an error.

This is **off by default** — nothing changes until you configure a chain.

## Enable / configure (environment variables)

| Setting | Value | Effect |
|---|---|---|
| `WEATHER_PROVIDER_FALLBACKS` | CSV of provider keys, e.g. `PW,OpenMeteo,Apple` | Ordered fallback chain tried after the primary provider. Unset ⇒ no fallback. |
| `PWS_FALLBACK_ENABLED` | `true` (or `1`/`yes`/`on`) | Also apply the chain to the **PWS** path. Off by default (a PWS failure returns an error, honoring your station choice). |

Provider keys are the same ones used for `provider` in `wto`: `AW`, `PW`, `Apple`, `OWM`,
`OpenMeteo`, `DWD`, `WU`. Unknown keys in the chain are skipped.

Per request, `wto.fallbacks` (an array or CSV) overrides `WEATHER_PROVIDER_FALLBACKS`.

## What does and does not fall through

**Falls through (transient / recoverable):** HTTP/parse/timeout errors, insufficient or
missing weather data, and "this provider can't do the requested method".

**Never falls through (deterministic):** PWS ID/key format errors, PWS authentication
failures, "no API key provided", location errors, and unexpected/bug errors. These would
fail on every provider (or must be fixed by you), so they surface immediately rather than
being masked by a silent provider swap.

## PWS behavior

By default, if you configured a personal weather station and it fails, the service returns
an error rather than silently substituting general-area data from another provider — your
explicit station choice is honored, and a bad API key is never hidden.

Set `PWS_FALLBACK_ENABLED=true` to opt into coordinate-based fallback for the PWS path. A
bad/expired key still fails fast (it is an auth error). When a non-PWS provider serves a
request in this mode, the response carries `rawData.pwsBypassed = 1` and a
`rawData.pwsBypassReason`, so the bypass is visible rather than silent.

## Notes

- Fallback is evaluated fresh on each request (no failure memo). A down primary costs one
  failed call per request until it recovers.
- A watering scale produced by a fallback provider is **not** cached, to avoid pinning a
  coarser result for the rest of the day. `rawData.wp` always reports the provider that
  actually served the data.
