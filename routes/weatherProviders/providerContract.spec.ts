import { expect } from "chai";
import { WeatherData, WeatherProviderId } from "../../types";
import { normalizeWeatherData } from "./normalizeWeatherData";

const providerIds: WeatherProviderId[] = [
	"AccuWeather",
	"Apple",
	"DWD",
	"OWM",
	"OpenMeteo",
	"PirateWeather",
	"WUnderground",
	"local"
];

const numericFields = [ "temp", "humidity", "wind", "minTemp", "maxTemp", "precip" ];

function validWeather( provider: WeatherProviderId ): WeatherData {
	return {
		weatherProvider: provider,
		temp: 72,
		humidity: 40,
		wind: 6,
		description: "Clear",
		icon: "01d",
		region: "",
		city: "",
		minTemp: 60,
		maxTemp: 80,
		precip: 0,
		forecast: []
	};
}

describe( "provider WeatherData contract", () => {
	let warn: typeof console.warn;
	let warnings: string[];

	beforeEach( () => {
		warn = console.warn;
		warnings = [];
		console.warn = ( message?: any ) => { warnings.push( String( message ) ); };
	} );

	afterEach( () => {
		console.warn = warn;
	} );

	for ( const provider of providerIds ) {
		describe( provider, () => {
			it( "passes a finite fixture through with no contract violations", () => {
				const raw = validWeather( provider );
				const out = normalizeWeatherData( provider, raw );
				expect( out ).to.deep.equal( raw );
				expect( out ).to.not.equal( raw );
				expect( out.contractViolations ).to.equal( undefined );
				expect( warnings ).to.deep.equal( [] );
			} );

			for ( const field of numericFields ) {
				for ( const badValue of [ "not numeric", NaN ] ) {
					const renderedValue = typeof badValue === "number" && Number.isNaN( badValue ) ? "NaN" : "string";

					it( `marks malformed ${ renderedValue } ${ field } as NaN with a ${ field } violation`, () => {
						const raw = validWeather( provider ) as any;
						raw[ field ] = badValue;
						const out = normalizeWeatherData( provider, raw );
						expect( Number.isNaN( ( out as any )[ field ] ) ).to.equal( true );
						expect( out.contractViolations ).to.have.length( 1 );
						expect( out.contractViolations![ 0 ] ).to.contain( provider );
						expect( out.contractViolations![ 0 ] ).to.contain( field );
						expect( warnings ).to.deep.equal( out.contractViolations );
					} );
				}

				it( `preserves absent ${ field } as undefined with no violation`, () => {
					const raw = validWeather( provider ) as any;
					raw[ field ] = undefined;
					const out = normalizeWeatherData( provider, raw );
					expect( ( out as any )[ field ] ).to.equal( undefined );
					expect( out.contractViolations ).to.equal( undefined );
					expect( warnings ).to.deep.equal( [] );
				} );
			}
		} );
	}
} );
