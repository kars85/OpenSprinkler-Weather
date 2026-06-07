# Weather Provider Precipitation Audit

This audit supports issues #8 and #11 by documenting each `getWeatherData` precipitation source and confirming that all eight providers are routed through `normalizeWeatherData` as of commit `07e07ab`.

| Provider | getWeatherData precip source | classification (numeric/fixed) | normalizer-routed (yes, commit 07e07ab) | notes |
|----------|------------------------------|--------------------------------|------------------------------------------|-------|
| AccuWeather | `daily[0].Day.TotalLiquid.Value`, coerced with `Number(...)` and retained only when finite | FIXED in #8 | yes | Previously categorical `Day.PrecipitationType`; now `TotalLiquid.Value` numeric. Malformed values normalize to `NaN` with a contract violation. |
| Apple | `forecastDaily.days[0].precipitationAmount`, converted from mm to inches; fallback uses `currentWeather.precipitationIntensity * 24` | numeric | yes | Apple WeatherKit precipitation fields are numeric quantities before unit conversion. |
| DWD | Bright Sky hourly `hour.precipitation` summed for day 0, then `this.mm2inch(precip)` | VERIFIED NUMERIC | yes | Issue #13 was a false positive: `DWD.ts` around line 99 has `precip: 0` only as an initializer, overwritten around line 138 with `this.mm2inch(precip)` for day 0. |
| OWM | `weatherData.daily[0].rain` defaulted to `0`, then divided by `25.4` | numeric | yes | OpenWeatherMap daily rain is numeric mm converted to inches. |
| OpenMeteo | `current.daily.precipitation_sum[0]` from a request using `precipitation_unit=inch` | numeric | yes | Open-Meteo returns daily precipitation sum as a numeric value in inches. |
| PirateWeather | `forecast.daily.data[0].precipIntensity * 24` | numeric | yes | Daily precip intensity is numeric and converted to a daily total estimate. |
| WUnderground | `forecast.qpf[0] + forecast.qpfSnow[0]` | numeric | yes | Forecast liquid and snow QPF fields are numeric inch totals. |
| local | Sum of queued observation `obs.precip` values, rounded to two decimals | numeric | yes | Local PWS observations derive precip from rain counter deltas before accumulation. |
