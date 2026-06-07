export interface SkipWeather {
	minTemp?: number;
	temp?: number;
	wind?: number;
	precip?: number;
}

export interface SkipConfig {
	freeze?: { temp: number };
	wind?: { max: number };
	rain?: { threshold: number };
}

export interface SkipResult {
	skip: boolean;
	reason?: string;
}

/** Strict boolean parse: only true/1/yes/on (case-insensitive) enable. Anything else is false. */
export function parseBool( v: string | undefined ): boolean {
	if ( v === undefined || v === null ) return false;
	return [ "true", "1", "yes", "on" ].indexOf( String( v ).trim().toLowerCase() ) !== -1;
}

function isNum( x: any ): x is number {
	return typeof x === "number" && Number.isFinite( x );
}

function r1( x: number ): number {
	return Math.round( x * 10 ) / 10;
}

/**
 * Evaluate freeze/wind/rain skips. Only enabled rules are present in cfg. Each rule is
 * independently fail-open (no-ops if its field is missing/non-finite). Inclusive boundaries.
 * Safety order: freeze, then wind, then rain. First trigger wins. Reasons are ASCII words only.
 */
export function evaluateSkips( w: SkipWeather, cfg: SkipConfig ): SkipResult {
	if ( cfg.freeze ) {
		const t = isNum( w.minTemp ) ? w.minTemp : ( isNum( w.temp ) ? w.temp : undefined );
		if ( isNum( t ) && t <= cfg.freeze.temp ) {
			return { skip: true, reason: `freeze: ${ r1( t ) }F at or below ${ cfg.freeze.temp }F` };
		}
	}
	if ( cfg.wind && isNum( w.wind ) && w.wind >= cfg.wind.max ) {
		return { skip: true, reason: `wind: ${ r1( w.wind ) }mph at or above ${ cfg.wind.max }mph` };
	}
	if ( cfg.rain && isNum( w.precip ) && w.precip >= cfg.rain.threshold ) {
		return { skip: true, reason: `rain: ${ r1( w.precip ) }in at or above ${ cfg.rain.threshold }in` };
	}
	return { skip: false };
}

export function anySkipEnabled( cfg: SkipConfig ): boolean {
	return !!( cfg.freeze || cfg.wind || cfg.rain );
}

function numOr( raw: any, fallback: number ): number {
	const v = Number( raw );
	return Number.isFinite( v ) ? v : fallback;
}

/**
 * Build a SkipConfig from env defaults overridden by per-request `wto` options.
 * Enabling a rule (SKIP_* / skip*) is strictly separate from its threshold value.
 * `env` is injectable for tests; defaults to process.env.
 */
export function resolveSkipConfig(
	adjustmentOptions: { [ k: string ]: any },
	env: { [ k: string ]: string | undefined } = process.env as any,
	forceRain: boolean = false
): SkipConfig {
	const o = adjustmentOptions || {};
	const enabled = ( wtoKey: string, envKey: string ): boolean =>
		o[ wtoKey ] !== undefined ? parseBool( String( o[ wtoKey ] ) ) : parseBool( env[ envKey ] );
	const value = ( wtoKey: string, envKey: string, def: number ): number =>
		o[ wtoKey ] !== undefined ? numOr( o[ wtoKey ], def ) : numOr( env[ envKey ], def );

	const cfg: SkipConfig = {};
	if ( enabled( "skipFreeze", "SKIP_FREEZE" ) ) cfg.freeze = { temp: value( "skipFreezeTemp", "FREEZE_TEMP", 32 ) };
	if ( enabled( "skipWind", "SKIP_WIND" ) ) cfg.wind = { max: value( "skipWindMax", "WIND_MAX", 25 ) };
	if ( enabled( "skipRain", "SKIP_RAIN" ) ) cfg.rain = { threshold: value( "skipRainThreshold", "RAIN_SKIP", 0.1 ) };
	if ( forceRain && !cfg.rain ) cfg.rain = { threshold: value( "skipRainThreshold", "RAIN_SKIP", 0.1 ) };
	return cfg;
}
