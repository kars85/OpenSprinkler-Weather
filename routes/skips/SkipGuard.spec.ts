import { expect } from "chai";
import { GeoCoordinates, PWS, WeatherData, ZimmermanWateringData } from "../../types";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import { EToData } from "../adjustmentMethods/EToAdjustmentMethod";
import { applyWeatherSkips, fetchSkipWeather, skipMemoKey, __clearSkipWeatherMemo } from "./SkipGuard";

// Stub provider whose getWeatherData returns canned data (or throws / counts calls).
class StubProvider extends WeatherProvider {
	public calls = 0;
	constructor( private readonly wd: Partial<WeatherData> | null, private readonly fail = false ) { super(); }
	public async getWateringData(): Promise< ZimmermanWateringData > { throw new Error( "n/a" ); }
	public async getEToData(): Promise< EToData > { throw new Error( "n/a" ); }
	public async getWeatherData(): Promise< WeatherData > {
		this.calls++;
		if ( this.fail ) throw new Error( "boom" );
		return this.wd as WeatherData;
	}
}

const coords: GeoCoordinates = [ 42.3732, -72.5199 ];

describe( "SkipGuard.skipMemoKey", () => {
	it( "isolates by provider, selected provider, coords, and pws", () => {
		const p = new StubProvider( {} );
		const a = skipMemoKey( p, coords, undefined, { provider: "OWM" } as any );
		expect( a ).to.contain( "StubProvider" ).and.contain( "OWM" ).and.contain( "42.3732,-72.5199" ).and.contain( "nopws" );
		expect( skipMemoKey( p, coords, undefined, { provider: "OpenMeteo" } as any ) ).to.not.equal( a );
		expect( skipMemoKey( p, [ 1, 2 ], undefined, { provider: "OWM" } as any ) ).to.not.equal( a );
		expect( skipMemoKey( p, coords, { id: "KMA", apiKey: "x" }, { provider: "OWM" } as any ) ).to.contain( "KMA" );
		expect( skipMemoKey( p, coords, { apiKey: "x" }, { provider: "OWM" } as any ) ).to.contain( "pwskey" );
	} );
} );

describe( "SkipGuard.fetchSkipWeather", () => {
	beforeEach( () => __clearSkipWeatherMemo() );

	it( "memoizes within the TTL and refetches after it expires", async () => {
		process.env.SKIP_WEATHER_TTL = "1000";
		const p = new StubProvider( { minTemp: 30, temp: 35, wind: 5, precip: 0 } );
		await fetchSkipWeather( p, coords, undefined, { provider: "OWM" } as any, 1000 );
		await fetchSkipWeather( p, coords, undefined, { provider: "OWM" } as any, 1500 ); // within TTL
		expect( p.calls ).to.equal( 1 );
		await fetchSkipWeather( p, coords, undefined, { provider: "OWM" } as any, 2500 ); // expired
		expect( p.calls ).to.equal( 2 );
		delete process.env.SKIP_WEATHER_TTL;
	} );

	it( "fails open (undefined) and does not memoize failures", async () => {
		const p = new StubProvider( null, true );
		expect( await fetchSkipWeather( p, coords, undefined, {} as any, 1000 ) ).to.equal( undefined );
		expect( await fetchSkipWeather( p, coords, undefined, {} as any, 1000 ) ).to.equal( undefined );
		expect( p.calls ).to.equal( 2 ); // re-attempted, not cached
	} );
} );

describe( "SkipGuard.applyWeatherSkips", () => {
	beforeEach( () => __clearSkipWeatherMemo() );
	const base = { scale: 80, rawData: { wp: "OWM", t: 70 } };

	it( "returns the input unchanged when no skip is enabled", async () => {
		const p = new StubProvider( { minTemp: 10 } );
		const out = await applyWeatherSkips( base, p, coords, undefined, {} as any, 1000 );
		expect( out ).to.equal( base ); // same reference, no fetch needed
		expect( p.calls ).to.equal( 0 );
	} );

	it( "forces scale 0 + skip metadata on a freeze, in a FRESH object (no mutation)", async () => {
		process.env.SKIP_FREEZE = "on";
		const p = new StubProvider( { minTemp: 28, temp: 30, wind: 4, precip: 0 } );
		const out = await applyWeatherSkips( base, p, coords, undefined, { provider: "OWM" } as any, 1000 );
		expect( out.scale ).to.equal( 0 );
		expect( out.rawData.skip ).to.equal( 1 );
		expect( out.rawData.skipReason ).to.contain( "freeze" );
		// original is untouched
		expect( base.scale ).to.equal( 80 );
		expect( ( base.rawData as any ).skip ).to.equal( undefined );
		expect( out.rawData ).to.not.equal( base.rawData );
		delete process.env.SKIP_FREEZE;
	} );

	it( "does NOT add metadata when enabled but conditions are mild", async () => {
		process.env.SKIP_FREEZE = "on";
		const p = new StubProvider( { minTemp: 50, temp: 55 } );
		const out = await applyWeatherSkips( base, p, coords, undefined, {} as any, 1000 );
		expect( out ).to.equal( base );
		delete process.env.SKIP_FREEZE;
	} );

	it( "leaves a restriction-induced 0 untouched and adds NO metadata when no skip fires", async () => {
		process.env.SKIP_FREEZE = "on";
		const restricted = { scale: 0, rawData: { wp: "OWM" } };
		const p = new StubProvider( { minTemp: 50 } ); // no freeze
		const out = await applyWeatherSkips( restricted, p, coords, undefined, {} as any, 1000 );
		expect( out ).to.equal( restricted );
		expect( ( out.rawData as any ).skip ).to.equal( undefined );
		expect( ( out.rawData as any ).skipReason ).to.equal( undefined );
		delete process.env.SKIP_FREEZE;
	} );

	it( "fails open when getWeatherData throws (no skip, input unchanged)", async () => {
		process.env.SKIP_FREEZE = "on";
		const p = new StubProvider( null, true );
		const out = await applyWeatherSkips( base, p, coords, undefined, {} as any, 1000 );
		expect( out ).to.equal( base );
		delete process.env.SKIP_FREEZE;
	} );
} );

describe( "SkipGuard.applyWeatherSkips forceRain", () => {
	beforeEach( () => __clearSkipWeatherMemo() );
	const base = { scale: 80, rawData: { wp: "OWM" } };

	it( "forces a rain skip on a wet day even when SKIP_RAIN is unset", async () => {
		const p = new StubProvider( { precip: 0.5, minTemp: 60, temp: 65, wind: 3 } );
		const out = await applyWeatherSkips( base, p, coords, undefined, {} as any, 1000, true );
		expect( out.scale ).to.equal( 0 );
		expect( out.rawData.skip ).to.equal( 1 );
		expect( out.rawData.skipReason ).to.contain( "rain" );
	} );

	it( "no-ops on a dry day under forceRain", async () => {
		const p = new StubProvider( { precip: 0, minTemp: 60, temp: 65, wind: 3 } );
		const out = await applyWeatherSkips( base, p, coords, undefined, {} as any, 1000, true );
		expect( out ).to.equal( base );
	} );

	it( "fails open under forceRain when weather is unavailable", async () => {
		const p = new StubProvider( null, true );
		const out = await applyWeatherSkips( base, p, coords, undefined, {} as any, 1000, true );
		expect( out ).to.equal( base );
	} );
} );
