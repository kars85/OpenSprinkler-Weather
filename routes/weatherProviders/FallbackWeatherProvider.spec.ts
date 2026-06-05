import { expect } from "chai";
import { GeoCoordinates } from "../../types";
import { CodedError, ErrorCode } from "../../errors";
import { WeatherProvider } from "./WeatherProvider";
import {
	buildFallbackChain, FallbackWeatherProvider, isFallbackEligible, isPwsFallbackEnabled, parseFallbackKeys
} from "./FallbackWeatherProvider";

describe( "FallbackWeatherProvider.isFallbackEligible", () => {
	it( "advances on transient/data errCodes and unsupported-method", () => {
		for ( const c of [ ErrorCode.BadWeatherData, ErrorCode.InsufficientWeatherData, ErrorCode.MissingWeatherField, ErrorCode.WeatherApiError, ErrorCode.UnsupportedAdjustmentMethod ] ) {
			expect( isFallbackEligible( new CodedError( c ) ), `code ${ c }` ).to.equal( true );
		}
	} );

	it( "does NOT advance on auth/config, location, option, invalid-method, or UnexpectedError", () => {
		for ( const c of [ ErrorCode.InvalidPwsId, ErrorCode.InvalidPwsApiKey, ErrorCode.PwsAuthenticationError, ErrorCode.PwsNotSupported, ErrorCode.NoPwsProvided, ErrorCode.NoAPIKeyProvided, ErrorCode.LocationError, ErrorCode.MissingAdjustmentOption, ErrorCode.InvalidAdjustmentMethod, ErrorCode.UnexpectedError ] ) {
			expect( isFallbackEligible( new CodedError( c ) ), `code ${ c }` ).to.equal( false );
		}
	} );

	it( "advances on network/timeout raw errors only", () => {
		const econn: any = new Error( "connection refused" ); econn.code = "ECONNREFUSED";
		const etimeout: any = new Error( "socket hang up" ); etimeout.code = "ETIMEDOUT";
		const timedOut = new Error( "HTTP request timed out after 10000 ms" );
		expect( isFallbackEligible( econn ) ).to.equal( true );
		expect( isFallbackEligible( etimeout ) ).to.equal( true );
		expect( isFallbackEligible( timedOut ) ).to.equal( true );
	} );

	it( "does NOT advance on arbitrary raw errors (would mask bugs)", () => {
		expect( isFallbackEligible( new Error( "undefined is not a function" ) ) ).to.equal( false );
		expect( isFallbackEligible( "weird" ) ).to.equal( false );
		expect( isFallbackEligible( undefined ) ).to.equal( false );
	} );
} );

describe( "FallbackWeatherProvider.isPwsFallbackEnabled", () => {
	it( "is off unless PWS_FALLBACK_ENABLED is a truthy token", () => {
		expect( isPwsFallbackEnabled( {} ) ).to.equal( false );
		expect( isPwsFallbackEnabled( { PWS_FALLBACK_ENABLED: "false" } ) ).to.equal( false );
		expect( isPwsFallbackEnabled( { PWS_FALLBACK_ENABLED: "true" } ) ).to.equal( true );
		expect( isPwsFallbackEnabled( { PWS_FALLBACK_ENABLED: "ON" } ) ).to.equal( true );
		expect( isPwsFallbackEnabled( { PWS_FALLBACK_ENABLED: "1" } ) ).to.equal( true );
	} );
} );

describe( "FallbackWeatherProvider.parseFallbackKeys", () => {
	it( "returns [] when neither wto nor env is set", () => {
		expect( parseFallbackKeys( {}, {} ) ).to.deep.equal( [] );
		expect( parseFallbackKeys( undefined, {} ) ).to.deep.equal( [] );
	} );

	it( "parses the env CSV (trimmed, non-empty)", () => {
		expect( parseFallbackKeys( {}, { WEATHER_PROVIDER_FALLBACKS: "PW, OpenMeteo ,, Apple" } ) ).to.deep.equal( [ "PW", "OpenMeteo", "Apple" ] );
	} );

	it( "lets wto.fallbacks (array or CSV) override env", () => {
		expect( parseFallbackKeys( { fallbacks: [ "OWM", "DWD" ] }, { WEATHER_PROVIDER_FALLBACKS: "PW" } ) ).to.deep.equal( [ "OWM", "DWD" ] );
		expect( parseFallbackKeys( { fallbacks: "OWM, DWD" }, { WEATHER_PROVIDER_FALLBACKS: "PW" } ) ).to.deep.equal( [ "OWM", "DWD" ] );
	} );
} );

describe( "FallbackWeatherProvider.buildFallbackChain", () => {
	it( "prepends primary, resolves keys via lookup, dedupes, skips unknown", () => {
		const primary = new WeatherProvider();
		const a = new WeatherProvider();
		const b = new WeatherProvider();
		const table: { [ k: string ]: WeatherProvider } = { A: a, B: b };
		const chain = buildFallbackChain( primary, [ "A", "X", "B", "A" ], k => table[ k ] );
		expect( chain ).to.deep.equal( [ primary, a, b ] );
	} );
} );

describe( "FallbackWeatherProvider (composite)", () => {
	const coords: GeoCoordinates = [ 42.3732, -72.5199 ];

	class Stub extends WeatherProvider {
		public etoCalls = 0;
		constructor( private readonly result: any, private readonly err?: unknown ) { super(); }
		public async getEToData(): Promise< any > {
			this.etoCalls++;
			if ( this.err ) throw this.err;
			return this.result;
		}
		public shouldCacheWateringScale(): boolean { return true; }
	}

	it( "returns the first provider's result without calling the rest", async () => {
		const a = new Stub( { weatherProvider: "OWM" } );
		const b = new Stub( { weatherProvider: "DWD" } );
		const fb = new FallbackWeatherProvider( [ a, b ] );
		const out: any = await fb.getEToData( coords );
		expect( out.weatherProvider ).to.equal( "OWM" );
		expect( a.etoCalls ).to.equal( 1 );
		expect( b.etoCalls ).to.equal( 0 );
		expect( fb.servedFallback ).to.equal( false );
	} );

	it( "advances to the next provider on a transient (eligible) error", async () => {
		const a = new Stub( null, new CodedError( ErrorCode.WeatherApiError ) );
		const b = new Stub( { weatherProvider: "DWD" } );
		const fb = new FallbackWeatherProvider( [ a, b ] );
		const out: any = await fb.getEToData( coords );
		expect( out.weatherProvider ).to.equal( "DWD" );
		expect( a.etoCalls ).to.equal( 1 );
		expect( b.etoCalls ).to.equal( 1 );
		expect( fb.servedFallback ).to.equal( true );
	} );

	it( "rethrows immediately (no advance) on a non-eligible error", async () => {
		const a = new Stub( null, new CodedError( ErrorCode.PwsAuthenticationError ) );
		const b = new Stub( { weatherProvider: "DWD" } );
		const fb = new FallbackWeatherProvider( [ a, b ] );
		let thrown: any;
		try { await fb.getEToData( coords ); } catch ( e ) { thrown = e; }
		expect( thrown ).to.be.instanceOf( CodedError );
		expect( thrown.errCode ).to.equal( ErrorCode.PwsAuthenticationError );
		expect( b.etoCalls ).to.equal( 0 );
	} );

	it( "throws the last error when every provider fails", async () => {
		const a = new Stub( null, new CodedError( ErrorCode.WeatherApiError ) );
		const b = new Stub( null, new CodedError( ErrorCode.InsufficientWeatherData ) );
		const fb = new FallbackWeatherProvider( [ a, b ] );
		let thrown: any;
		try { await fb.getEToData( coords ); } catch ( e ) { thrown = e; }
		expect( thrown.errCode ).to.equal( ErrorCode.InsufficientWeatherData );
	} );

	it( "advances on UnsupportedAdjustmentMethod (capability fallback)", async () => {
		const a = new Stub( null, new CodedError( ErrorCode.UnsupportedAdjustmentMethod ) );
		const b = new Stub( { weatherProvider: "DWD" } );
		const fb = new FallbackWeatherProvider( [ a, b ] );
		const out: any = await fb.getEToData( coords );
		expect( out.weatherProvider ).to.equal( "DWD" );
	} );

	it( "flags pwsBypassed + reason only when primaryIsPws and a fallback served", async () => {
		const pwsP = new Stub( null, new CodedError( ErrorCode.WeatherApiError ) );
		const coord = new Stub( { weatherProvider: "OWM" } );
		const fb = new FallbackWeatherProvider( [ pwsP, coord ], true );
		await fb.getEToData( coords );
		expect( fb.pwsBypassed ).to.equal( true );
		expect( fb.pwsBypassReason ).to.equal( "errCode 12" );
	} );

	it( "does NOT flag pwsBypassed when the PWS primary serves", async () => {
		const pwsP = new Stub( { weatherProvider: "WUnderground" } );
		const coord = new Stub( { weatherProvider: "OWM" } );
		const fb = new FallbackWeatherProvider( [ pwsP, coord ], true );
		await fb.getEToData( coords );
		expect( fb.pwsBypassed ).to.equal( false );
	} );

	it( "shouldCacheWateringScale follows the primary", () => {
		const fb = new FallbackWeatherProvider( [ new Stub( {} ) ] );
		expect( fb.shouldCacheWateringScale() ).to.equal( true );
	} );

	it( "exposes forecast capability from a forecast-capable child", async () => {
		const plain = new Stub( {} );
		const forecaster: any = new Stub( {} );
		forecaster.supportsForecasting = () => true;
		forecaster.getForecastData = async () => [ { confidence: "high" } ];
		forecaster.getBestForecastMethod = () => "full";
		const fb = new FallbackWeatherProvider( [ plain, forecaster ] );
		expect( fb.supportsForecasting() ).to.equal( true );
		expect( fb.getBestForecastMethod( await fb.getForecastData( coords, 3 ) ) ).to.equal( "full" );
	} );

	it( "reports no forecast capability when no child supports it", () => {
		const fb = new FallbackWeatherProvider( [ new Stub( {} ), new Stub( {} ) ] );
		expect( fb.supportsForecasting() ).to.equal( false );
	} );
} );
