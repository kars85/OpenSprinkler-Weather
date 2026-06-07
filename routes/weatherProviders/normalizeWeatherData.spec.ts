import { expect } from "chai";
import { WeatherData } from "../../types";
import { normalizeWeatherData } from "./normalizeWeatherData";

describe( "normalizeWeatherData", () => {
	let warn: typeof console.warn;
	let warnings: string[];

	const validWeather = (): WeatherData => ( {
		weatherProvider: "OWM",
		temp: 72,
		humidity: 40,
		wind: 6,
		description: "Clear",
		icon: "01d",
		region: "MA",
		city: "Amherst",
		minTemp: 60,
		maxTemp: 80,
		precip: 0,
		forecast: [ { temp_min: 61, temp_max: 79, date: 1717200000, icon: "01d", description: "Clear" } ]
	} );

	beforeEach( () => {
		warn = console.warn;
		warnings = [];
		console.warn = ( message?: any ) => { warnings.push( String( message ) ); };
	} );

	afterEach( () => {
		console.warn = warn;
	} );

	it( "passes finite numeric fields through unchanged", () => {
		const raw = validWeather();
		const out = normalizeWeatherData( "OWM", raw );
		expect( out ).to.deep.equal( raw );
		expect( out ).to.not.equal( raw );
		expect( warnings ).to.deep.equal( [] );
	} );

	it( "preserves absent numeric fields as undefined with no violation", () => {
		const raw = validWeather() as any;
		raw.minTemp = undefined;
		raw.maxTemp = null;
		const out = normalizeWeatherData( "local", raw );
		expect( out.minTemp ).to.equal( undefined );
		expect( out.maxTemp ).to.equal( undefined );
		expect( out.contractViolations ).to.equal( undefined );
		expect( warnings ).to.deep.equal( [] );
	} );

	it( "marks malformed string precipitation as NaN with a precip violation", () => {
		const raw = validWeather() as any;
		raw.precip = "Light";
		const out = normalizeWeatherData( "AccuWeather", raw );
		expect( Number.isNaN( out.precip ) ).to.equal( true );
		expect( out.contractViolations ).to.have.length( 1 );
		expect( out.contractViolations![ 0 ] ).to.contain( "AccuWeather" );
		expect( out.contractViolations![ 0 ] ).to.contain( "precip" );
		expect( out.contractViolations![ 0 ] ).to.contain( "\"Light\"" );
		expect( warnings ).to.deep.equal( out.contractViolations );
	} );

	it( "marks malformed NaN precipitation as a contract violation", () => {
		const raw = validWeather();
		raw.precip = NaN;
		const out = normalizeWeatherData( "OWM", raw );
		expect( Number.isNaN( out.precip ) ).to.equal( true );
		expect( out.contractViolations ).to.have.length( 1 );
		expect( out.contractViolations![ 0 ] ).to.contain( "precip" );
		expect( out.contractViolations![ 0 ] ).to.contain( "NaN" );
		expect( warnings ).to.deep.equal( out.contractViolations );
	} );

	it( "accumulates multiple malformed field violations", () => {
		const raw = validWeather() as any;
		raw.temp = "warm";
		raw.wind = Infinity;
		raw.precip = "Light";
		const out = normalizeWeatherData( "mixed", raw );
		expect( Number.isNaN( out.temp ) ).to.equal( true );
		expect( Number.isNaN( out.wind ) ).to.equal( true );
		expect( Number.isNaN( out.precip ) ).to.equal( true );
		expect( out.contractViolations ).to.have.length( 3 );
		expect( out.contractViolations!.join( "\n" ) ).to.contain( "temp" );
		expect( out.contractViolations!.join( "\n" ) ).to.contain( "wind" );
		expect( out.contractViolations!.join( "\n" ) ).to.contain( "precip" );
		expect( warnings ).to.deep.equal( out.contractViolations );
	} );

	it( "omits contractViolations for a fully-valid object", () => {
		const out = normalizeWeatherData( "OWM", validWeather() );
		expect( out.contractViolations ).to.equal( undefined );
		expect( warnings ).to.deep.equal( [] );
	} );
} );
