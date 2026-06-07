import { expect } from "chai";
import { anySkipEnabled, evaluateSkips, parseBool, resolveSkipConfig, SkipConfig } from "./WeatherSkips";

describe( "WeatherSkips.parseBool", () => {
	it( "enables only on true/1/yes/on (case-insensitive)", () => {
		for ( const t of [ "true", "TRUE", "1", "yes", "On" ] ) expect( parseBool( t ) ).to.equal( true );
		for ( const f of [ undefined, "", "false", "0", "no", "off", "enabled", "x" ] ) expect( parseBool( f as any ) ).to.equal( false );
	} );
} );

describe( "WeatherSkips.evaluateSkips", () => {
	it( "no enabled rules => no skip", () => {
		expect( evaluateSkips( { minTemp: -50, wind: 99, precip: 9 }, {} ) ).to.deep.equal( { skip: false } );
	} );

	it( "freeze fires inclusively and reports ASCII reason (no = < > quotes)", () => {
		const r = evaluateSkips( { minTemp: 32 }, { freeze: { temp: 32 } } );
		expect( r.skip ).to.equal( true );
		expect( r.reason ).to.equal( "freeze: 32F at or below 32F" );
		expect( /[=<>"]/.test( r.reason! ) ).to.equal( false );
		expect( evaluateSkips( { minTemp: 33 }, { freeze: { temp: 32 } } ).skip ).to.equal( false );
	} );

	it( "freeze falls back to current temp when minTemp is missing (local/PWS)", () => {
		expect( evaluateSkips( { temp: 30 }, { freeze: { temp: 32 } } ).skip ).to.equal( true );
		expect( evaluateSkips( { minTemp: undefined, temp: 30 } as any, { freeze: { temp: 32 } } ).skip ).to.equal( true );
	} );

	it( "wind and rain fire inclusively", () => {
		expect( evaluateSkips( { wind: 25 }, { wind: { max: 25 } } ).reason ).to.equal( "wind: 25mph at or above 25mph" );
		expect( evaluateSkips( { wind: 24 }, { wind: { max: 25 } } ).skip ).to.equal( false );
		expect( evaluateSkips( { precip: 0.1 }, { rain: { threshold: 0.1 } } ).reason ).to.equal( "rain: 0.1in at or above 0.1in" );
		expect( evaluateSkips( { precip: 0.05 }, { rain: { threshold: 0.1 } } ).skip ).to.equal( false );
	} );

	it( "a missing field disables only its own rule; other rules still evaluate", () => {
		// No temp data at all, but wind is high -> wind still fires.
		const cfg: SkipConfig = { freeze: { temp: 32 }, wind: { max: 25 }, rain: { threshold: 0.1 } };
		const r = evaluateSkips( { wind: 30 }, cfg );
		expect( r.skip ).to.equal( true );
		expect( r.reason ).to.contain( "wind" );
	} );

	it( "first trigger wins in freeze > wind > rain order", () => {
		const cfg: SkipConfig = { freeze: { temp: 32 }, wind: { max: 25 }, rain: { threshold: 0.1 } };
		expect( evaluateSkips( { minTemp: 20, wind: 30, precip: 1 }, cfg ).reason ).to.contain( "freeze" );
		expect( evaluateSkips( { minTemp: 50, wind: 30, precip: 1 }, cfg ).reason ).to.contain( "wind" );
		expect( evaluateSkips( { minTemp: 50, wind: 5, precip: 1 }, cfg ).reason ).to.contain( "rain" );
	} );

	it( "non-finite fields never trigger a skip", () => {
		const cfg: SkipConfig = { freeze: { temp: 32 }, wind: { max: 25 }, rain: { threshold: 0.1 } };
		expect( evaluateSkips( { minTemp: NaN, temp: NaN, wind: NaN, precip: NaN }, cfg ).skip ).to.equal( false );
	} );
} );

describe( "WeatherSkips.resolveSkipConfig", () => {
	it( "is empty when nothing is enabled (threshold alone never enables)", () => {
		const cfg = resolveSkipConfig( {}, { FREEZE_TEMP: "40", WIND_MAX: "10", RAIN_SKIP: "0.2" } );
		expect( anySkipEnabled( cfg ) ).to.equal( false );
		expect( cfg ).to.deep.equal( {} );
	} );

	it( "enables rules from env with defaults", () => {
		const cfg = resolveSkipConfig( {}, { SKIP_FREEZE: "on", SKIP_WIND: "1", SKIP_RAIN: "yes" } );
		expect( cfg ).to.deep.equal( { freeze: { temp: 32 }, wind: { max: 25 }, rain: { threshold: 0.1 } } );
	} );

	it( "env thresholds override defaults only for enabled rules", () => {
		const cfg = resolveSkipConfig( {}, { SKIP_FREEZE: "true", FREEZE_TEMP: "37", WIND_MAX: "10" } );
		expect( cfg ).to.deep.equal( { freeze: { temp: 37 } } );
	} );

	it( "wto overrides env (enable + threshold)", () => {
		const cfg = resolveSkipConfig( { skipWind: "on", skipWindMax: 18 }, { SKIP_WIND: "off", WIND_MAX: "25" } );
		expect( cfg ).to.deep.equal( { wind: { max: 18 } } );
	} );
} );

describe( "WeatherSkips.resolveSkipConfig forceRain", () => {
	it( "force-enables rain when no rain config is present (threshold env/wto/default)", () => {
		expect( resolveSkipConfig( {}, {}, true ) ).to.deep.equal( { rain: { threshold: 0.1 } } );
		expect( resolveSkipConfig( {}, { RAIN_SKIP: "0.25" }, true ) ).to.deep.equal( { rain: { threshold: 0.25 } } );
		expect( resolveSkipConfig( { skipRainThreshold: 0.3 }, { RAIN_SKIP: "0.25" }, true ) ).to.deep.equal( { rain: { threshold: 0.3 } } );
	} );

	it( "force-enables rain even when skipRain is explicitly off", () => {
		expect( resolveSkipConfig( {}, { SKIP_RAIN: "false" }, true ) ).to.deep.equal( { rain: { threshold: 0.1 } } );
	} );

	it( "does not override an already-enabled rain config", () => {
		expect( resolveSkipConfig( { skipRain: "on", skipRainThreshold: 0.5 }, {}, true ) ).to.deep.equal( { rain: { threshold: 0.5 } } );
	} );

	it( "forceRain defaults to false (adds no rain rule)", () => {
		expect( resolveSkipConfig( {}, {} ) ).to.deep.equal( {} );
	} );
} );
