import { expect } from "chai";
import nock from "nock";
import * as MockDate from "mockdate";
import LocalWeatherProvider from "./local";

/** A minimally-valid OpenMeteo /v1/forecast response shaped the way getForecastData parses it. */
function openMeteoBody( days = 3 ): object {
	const hours = days * 24;
	return {
		daily: {
			time: Array.from( { length: days }, ( _, i ) => 1000 + i ),
			temperature_2m_max: Array( days ).fill( 87 ),
			temperature_2m_min: Array( days ).fill( 66 ),
			precipitation_sum: Array( days ).fill( 0.1 ),
			windspeed_10m_max: Array( days ).fill( 3.3 ),
		},
		hourly: {
			relativehumidity_2m: Array( hours ).fill( 70 ),
			direct_radiation: Array( hours ).fill( 200 ),
			cloudcover: Array( hours ).fill( 10 ),
		},
	};
}

describe( "LocalWeatherProvider.getForecastData — timeout/cache/stale-if-error", () => {
	beforeEach( () => nock.disableNetConnect() );
	afterEach( () => { nock.cleanAll(); nock.enableNetConnect(); MockDate.reset(); } );

	// Unique coordinates per test so the module-level forecast cache never leaks across cases.

	it( "caches a fresh forecast — the second call makes no upstream request", async () => {
		const coords: [ number, number ] = [ 40.001, -90.001 ];
		const scope = nock( "https://api.open-meteo.com" ).get( /.*/ ).query( true ).reply( 200, openMeteoBody() );
		const p = new LocalWeatherProvider();

		const first = await p.getForecastData( coords, 3 );
		expect( first ).to.have.length( 3 );
		expect( scope.isDone() ).to.equal( true );        // the single interceptor was consumed

		// No second interceptor + disableNetConnect => a real fetch would throw. A clean return proves a cache hit.
		const second = await p.getForecastData( coords, 3 );
		expect( second ).to.have.length( 3 );
	} );

	it( "serves stale-if-error when a refresh fails after the fresh TTL", async () => {
		const coords: [ number, number ] = [ 41.002, -91.002 ];
		MockDate.set( "2026-06-11T00:00:00Z" );
		nock( "https://api.open-meteo.com" ).get( /.*/ ).query( true ).reply( 200, openMeteoBody() );
		const p = new LocalWeatherProvider();
		const fresh = await p.getForecastData( coords, 3 );
		expect( fresh ).to.have.length( 3 );

		MockDate.set( "2026-06-11T04:00:00Z" );            // past the 3h fresh TTL → refresh attempted
		nock( "https://api.open-meteo.com" ).get( /.*/ ).query( true ).reply( 500 );  // refresh fails
		const stale = await p.getForecastData( coords, 3 );
		expect( stale ).to.deep.equal( fresh );           // last-good forecast reused, not dropped
	} );

	it( "re-throws on a cold cache so ETo falls back to local-only", async () => {
		const coords: [ number, number ] = [ 42.003, -92.003 ];
		nock( "https://api.open-meteo.com" ).get( /.*/ ).query( true ).reply( 500 );
		const p = new LocalWeatherProvider();
		let threw = false;
		try { await p.getForecastData( coords, 3 ); } catch { threw = true; }
		expect( threw ).to.equal( true );
	} );
} );
