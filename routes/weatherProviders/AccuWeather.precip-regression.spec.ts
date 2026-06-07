import { expect } from "chai";
import { WeatherData } from "../../types";
import { evaluateSkips } from "../skips/WeatherSkips";
import { normalizeWeatherData } from "./normalizeWeatherData";

describe( "AccuWeather categorical precipitation regression", () => {
	let warn: typeof console.warn;
	let warnings: string[];

	const accuWeather = (): WeatherData => ( {
		weatherProvider: "AccuWeather",
		temp: 72,
		humidity: 40,
		wind: 6,
		description: "Cloudy",
		icon: "04d",
		region: "MA",
		city: "Amherst",
		minTemp: 60,
		maxTemp: 80,
		precip: "Heavy" as any,
		forecast: [ { temp_min: 61, temp_max: 79, date: 1717200000, icon: "04d", description: "Cloudy" } ]
	} );

	beforeEach( () => {
		warn = console.warn;
		warnings = [];
		console.warn = ( message?: any ) => { warnings.push( String( message ) ); };
	} );

	afterEach( () => {
		console.warn = warn;
	} );

	it( "normalizes categorical precip to NaN and fail-opens rain skip evaluation", () => {
		const out = normalizeWeatherData( "AccuWeather", accuWeather() );

		expect( Number.isNaN( out.precip ) ).to.equal( true );
		expect( out.contractViolations ).to.have.length( 1 );
		expect( out.contractViolations![ 0 ] ).to.contain( "AccuWeather" );
		expect( out.contractViolations![ 0 ] ).to.contain( "precip" );
		expect( warnings ).to.deep.equal( out.contractViolations );

		expect( () => evaluateSkips( out, { rain: { threshold: 0.1 } } ) ).to.not.throw();
		expect( evaluateSkips( out, { rain: { threshold: 0.1 } } ) ).to.deep.equal( { skip: false } );
	} );
} );
