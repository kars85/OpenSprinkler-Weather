import { GeoCoordinates, PWS, WeatherData, ZimmermanWateringData } from "../../types";
import { WeatherProvider } from "./WeatherProvider";
import { EToData } from "../adjustmentMethods/EToAdjustmentMethod";
import { CodedError, ErrorCode } from "../../errors";

const RAW_NETWORK_CODES = [ "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN" ];

/**
 * Decide whether an error from a provider call should advance to the next provider in the
 * chain. Transient/data errors and unsupported-method advance; auth/config, location, option,
 * invalid-method, and UnexpectedError(99) do NOT (they would fail on every provider, or signal
 * a bug that should surface). Raw (non-Coded) errors advance only when network/timeout-shaped.
 */
export function isFallbackEligible( err: unknown ): boolean {
	if ( err instanceof CodedError ) {
		switch ( err.errCode ) {
			case ErrorCode.BadWeatherData:
			case ErrorCode.InsufficientWeatherData:
			case ErrorCode.MissingWeatherField:
			case ErrorCode.WeatherApiError:
			case ErrorCode.UnsupportedAdjustmentMethod:
				return true;
			default:
				return false;
		}
	}
	const code = ( err as any ) && ( err as any ).code;
	if ( typeof code === "string" && RAW_NETWORK_CODES.indexOf( code ) !== -1 ) return true;
	const msg = ( err as any ) && ( err as any ).message;
	if ( typeof msg === "string" && /timed out/i.test( msg ) ) return true;
	return false;
}

/** Strict enable check for the PWS-fallback opt-in. Accepts true/1/yes/on (case-insensitive). */
export function isPwsFallbackEnabled( env: { [ k: string ]: string | undefined } = process.env as any ): boolean {
	const v = env.PWS_FALLBACK_ENABLED;
	if ( v === undefined || v === null ) return false;
	return [ "true", "1", "yes", "on" ].indexOf( String( v ).trim().toLowerCase() ) !== -1;
}

/**
 * Resolve the ordered list of fallback provider keys: per-request `wto.fallbacks` (array or CSV)
 * overrides the `WEATHER_PROVIDER_FALLBACKS` env CSV. Returns [] when neither is set.
 */
export function parseFallbackKeys(
	adjustmentOptions: { fallbacks?: string | string[] } | undefined,
	env: { [ k: string ]: string | undefined } = process.env as any
): string[] {
	const raw = adjustmentOptions && adjustmentOptions.fallbacks !== undefined
		? adjustmentOptions.fallbacks
		: env.WEATHER_PROVIDER_FALLBACKS;
	if ( raw === undefined || raw === null ) return [];
	const list = Array.isArray( raw ) ? raw : String( raw ).split( "," );
	return list.map( s => String( s ).trim() ).filter( s => s.length > 0 );
}

/**
 * Build a deduped provider chain: [primary, ...resolved fallbacks]. `lookup` maps a provider key
 * to an instance (or undefined for unknown keys, which are skipped).
 */
export function buildFallbackChain(
	primary: WeatherProvider,
	fallbackKeys: string[],
	lookup: ( key: string ) => WeatherProvider | undefined
): WeatherProvider[] {
	const chain: WeatherProvider[] = [ primary ];
	for ( const key of fallbackKeys ) {
		const p = lookup( key );
		if ( p && chain.indexOf( p ) === -1 ) chain.push( p );
	}
	return chain;
}

function describeErr( err: unknown ): string {
	if ( err instanceof CodedError ) return "errCode " + err.errCode;
	const code = ( err as any ) && ( err as any ).code;
	if ( typeof code === "string" ) return code;
	return "error";
}

/**
 * A WeatherProvider that wraps an ordered chain of providers. Each interface method tries the
 * chain in order; on a fallback-eligible error it advances, otherwise it rethrows immediately.
 * If every provider fails, the last error is thrown. Per-request state (servedIndex, bypass
 * reason) lets the caller annotate the response and decide caching.
 *
 * Construct PER REQUEST (a cheap array wrap of singleton providers) so the per-request state is
 * never shared across concurrent requests.
 */
export class FallbackWeatherProvider extends WeatherProvider {
	private servedIndex: number = -1;
	private lastFallbackReason: string | undefined = undefined;

	constructor(
		private readonly chain: WeatherProvider[],
		private readonly primaryIsPws: boolean = false
	) {
		super();
	}

	/** True if a non-primary provider answered the most recent call. */
	public get servedFallback(): boolean {
		return this.servedIndex > 0;
	}

	/** True if the primary was a PWS provider and a non-PWS fallback answered. */
	public get pwsBypassed(): boolean {
		return this.primaryIsPws && this.servedIndex > 0;
	}

	/** A short, non-sensitive reason for the most recent bypass (e.g. "errCode 12"). */
	public get pwsBypassReason(): string | undefined {
		return this.lastFallbackReason;
	}

	private async run< T >( fn: ( p: WeatherProvider ) => Promise< T > ): Promise< T > {
		let lastErr: unknown;
		for ( let i = 0; i < this.chain.length; i++ ) {
			try {
				const result = await fn( this.chain[ i ] );
				this.servedIndex = i;
				return result;
			} catch ( err ) {
				lastErr = err;
				if ( i === this.chain.length - 1 || !isFallbackEligible( err ) ) throw err;
				this.lastFallbackReason = describeErr( err );
			}
		}
		throw lastErr;
	}

	public getWateringData( coordinates: GeoCoordinates, pws?: PWS ): Promise< ZimmermanWateringData > {
		return this.run( p => p.getWateringData( coordinates, pws ) );
	}

	public getEToData( coordinates: GeoCoordinates, pws?: PWS ): Promise< EToData > {
		return this.run( p => p.getEToData( coordinates, pws ) );
	}

	public getWeatherData( coordinates: GeoCoordinates, pws?: PWS ): Promise< WeatherData > {
		return this.run( p => p.getWeatherData( coordinates, pws ) );
	}

	/** Cache eligibility follows the primary provider. */
	public shouldCacheWateringScale(): boolean {
		return this.chain[ 0 ].shouldCacheWateringScale();
	}

	// --- Forecast surface: delegate to the first forecast-capable provider in the chain. ---

	private forecastChild(): any | undefined {
		for ( const p of this.chain ) {
			if ( typeof ( p as any ).supportsForecasting === "function" && ( p as any ).supportsForecasting() ) return p;
		}
		return undefined;
	}

	public supportsForecasting(): boolean {
		return !!this.forecastChild();
	}

	public getForecastCapabilities(): any {
		const c = this.forecastChild();
		return c ? c.getForecastCapabilities() : undefined;
	}

	public getForecastData( coordinates: GeoCoordinates, days: number, pws?: PWS ): Promise< any > {
		const c = this.forecastChild();
		return c ? c.getForecastData( coordinates, days, pws ) : Promise.resolve( [] );
	}

	public getBestForecastMethod( forecastData: any ): any {
		const c = this.forecastChild();
		return c ? c.getBestForecastMethod( forecastData ) : "none";
	}
}
