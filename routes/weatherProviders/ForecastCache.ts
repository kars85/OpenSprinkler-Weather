/**
 * A tiny in-process forecast cache with a "fresh" TTL and a longer "stale-if-error" window.
 *
 * Why this exists: the OpenMeteo forecast fetch sits in the synchronous request path that the
 * OpenSprinkler firmware reads with a HARD 5s deadline. An occasional slow upstream call therefore
 * surfaces on the device as `wterr=-4` (empty read) and the controller coasts on a stale water level.
 * Caching the forecast keeps the upstream call off the hot path for the vast majority of polls, and the
 * stale window lets us serve the last-good forecast when a refresh fails — strictly better than dropping
 * the forecast term (degrading to local-only ETo), which we only do on a true cold cache.
 *
 * Not node-cache: node-cache evicts on TTL, which would discard the value we need for stale-if-error.
 * A small Map with explicit age checks keeps the last-good entry available past the fresh TTL.
 */

export interface ForecastCacheEntry< T > {
	data: T;
	fetchedAt: number;   // ms epoch
}

export interface ForecastLookup< T > {
	/** The cached payload. */
	data: T;
	/** Age of the entry in milliseconds. */
	ageMs: number;
	/** True when the entry is within the fresh TTL (no refresh needed). */
	fresh: boolean;
}

export default class ForecastCache< T = unknown > {
	private readonly store = new Map< string, ForecastCacheEntry< T > >();

	/**
	 * @param freshTtlMs How long a cached forecast is served without a refresh (default 3h).
	 * @param staleTtlMs How long a stale forecast may be served on refresh failure (default 6h).
	 */
	constructor(
		private readonly freshTtlMs: number = 3 * 60 * 60 * 1000,
		private readonly staleTtlMs: number = 6 * 60 * 60 * 1000,
	) {}

	/** Look up an entry regardless of freshness; evicts entries older than the stale window. */
	get( key: string ): ForecastLookup< T > | undefined {
		const entry = this.store.get( key );
		if ( !entry ) return undefined;
		const ageMs = Date.now() - entry.fetchedAt;
		if ( ageMs > this.staleTtlMs ) {
			this.store.delete( key );
			return undefined;
		}
		return { data: entry.data, ageMs, fresh: ageMs <= this.freshTtlMs };
	}

	/** Convenience: the data only if it is within the fresh TTL (the no-fetch hot path). */
	getFresh( key: string ): T | undefined {
		const hit = this.get( key );
		return hit && hit.fresh ? hit.data : undefined;
	}

	/** Convenience: the data if it is within the stale window (used as a refresh-failure fallback). */
	getStale( key: string ): T | undefined {
		const hit = this.get( key );
		return hit ? hit.data : undefined;
	}

	set( key: string, data: T ): void {
		this.store.set( key, { data, fetchedAt: Date.now() } );
	}

	/** Test/diagnostic helper. */
	clear(): void {
		this.store.clear();
	}
}
