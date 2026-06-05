import { GeoCoordinates, PWS, WeatherData } from "../../types";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import { AdjustmentOptions } from "../adjustmentMethods/AdjustmentMethod";
import { anySkipEnabled, evaluateSkips, resolveSkipConfig, SkipWeather } from "./WeatherSkips";

interface MemoEntry { weather: SkipWeather; expires: number; }

// Module-level memo, intentionally separate from WateringScaleCache (different TTL/semantics).
const memo: { [ key: string ]: MemoEntry } = {};

function ttlMs(): number {
	const v = Number( process.env.SKIP_WEATHER_TTL );
	return Number.isFinite( v ) && v > 0 ? v : 600000; // default 10 min
}

/** Test helper: clear the memo between cases. */
export function __clearSkipWeatherMemo(): void {
	for ( const k in memo ) delete memo[ k ];
}

/**
 * Memo key guards against cross-poisoning: provider mode (local vs remote), provider class,
 * selected provider, rounded coords, and PWS identity (id, else a generic marker for key-only).
 */
export function skipMemoKey(
	weatherProvider: WeatherProvider, coordinates: GeoCoordinates,
	pws: PWS | undefined, adjustmentOptions: AdjustmentOptions
): string {
	const mode = process.env.WEATHER_PROVIDER === "local" ? "local" : "remote";
	const provider = weatherProvider && weatherProvider.constructor ? weatherProvider.constructor.name : "unknown";
	const selected = ( adjustmentOptions && adjustmentOptions.provider ) || "";
	const coords = `${ coordinates[ 0 ].toFixed( 4 ) },${ coordinates[ 1 ].toFixed( 4 ) }`;
	const pwsKey = pws ? ( pws.id || "pwskey" ) : "nopws";
	return `${ mode }|${ provider }|${ selected }|${ coords }|${ pwsKey }`;
}

/**
 * One fail-open getWeatherData call, memoized with a short TTL. Returns undefined on any failure
 * (and does not memoize the failure). `now` is injectable for deterministic tests.
 */
export async function fetchSkipWeather(
	weatherProvider: WeatherProvider, coordinates: GeoCoordinates, pws: PWS | undefined,
	adjustmentOptions: AdjustmentOptions, now: number = Date.now()
): Promise< SkipWeather | undefined > {
	const key = skipMemoKey( weatherProvider, coordinates, pws, adjustmentOptions );
	const hit = memo[ key ];
	if ( hit && hit.expires > now ) return hit.weather;
	let wd: WeatherData;
	try {
		wd = await weatherProvider.getWeatherData( coordinates, pws );
	} catch ( err ) {
		return undefined; // fail-open; do not memoize failures
	}
	if ( !wd ) return undefined;
	const weather: SkipWeather = { minTemp: wd.minTemp, temp: wd.temp, wind: wd.wind, precip: wd.precip };
	memo[ key ] = { weather, expires: now + ttlMs() };
	return weather;
}

/**
 * Live skip overlay. Returns the input unchanged unless a skip actually fires, in which case it
 * returns a FRESH object with scale = 0 and rawData.skip / rawData.skipReason. Never mutates the
 * (possibly cached) input. Fail-open at every step.
 */
export async function applyWeatherSkips(
	dataToSend: any, weatherProvider: WeatherProvider, coordinates: GeoCoordinates,
	pws: PWS | undefined, adjustmentOptions: AdjustmentOptions, now: number = Date.now()
): Promise< any > {
	const cfg = resolveSkipConfig( adjustmentOptions || {} );
	if ( !anySkipEnabled( cfg ) ) return dataToSend;
	const weather = await fetchSkipWeather( weatherProvider, coordinates, pws, adjustmentOptions, now );
	if ( !weather ) return dataToSend; // fail-open: no usable weather
	const result = evaluateSkips( weather, cfg );
	if ( !result.skip ) return dataToSend; // never invent metadata
	return {
		...dataToSend,
		scale: 0,
		rawData: { ...( dataToSend.rawData || {} ), skip: 1, skipReason: result.reason }
	};
}
