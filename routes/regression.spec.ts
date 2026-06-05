import { expect } from "chai";
import * as nock from "nock";

import { CodedError, ErrorCode } from "../errors";
import { calculateETo, EToData } from "./adjustmentMethods/EToAdjustmentMethod";
import AccuWeatherWeatherProvider from "./weatherProviders/AccuWeather";
import OpenMeteoWeatherProvider from "./weatherProviders/OpenMeteo";

describe( "Regression coverage", () => {
	afterEach( () => {
		nock.cleanAll();
	} );

	it( "keeps ETo finite at extreme northern latitudes", () => {
		const etoData: EToData = {
			weatherProvider: "mock",
			periodStartTime: 1717545600,
			minTemp: 52,
			maxTemp: 68,
			minHumidity: 45,
			maxHumidity: 85,
			windSpeed: 6,
			solarRadiation: 5.2,
			precip: 0
		};

		const result = calculateETo( etoData, 100, [ 85, 0 ] );

		expect( Number.isFinite( result ) ).to.equal( true );
		expect( result ).not.to.satisfy( Number.isNaN );
	} );

	it( "throws InsufficientWeatherData when OpenMeteo watering data has no valid samples", async () => {
		nock( "https://api.open-meteo.com" )
			.get( "/v1/forecast" )
			.query( true )
			.reply( 200, {
				hourly: {
					time: [ 1717545600, 1717549200 ],
					temperature_2m: [ null, null ],
					relativehumidity_2m: [ null, null ],
					precipitation: [ null, null ]
				}
			} );

		const provider = new OpenMeteoWeatherProvider();

		await expectCodedError(
			() => provider.getWateringData( [ 42.3732, -72.5199 ] ),
			ErrorCode.InsufficientWeatherData
		);
	} );

	it( "throws a coded location error when AccuWeather location lookup fails", async () => {
		process.env.ACCUWEATHER_API_KEY = "NO_KEY";

		nock( "https://dataservice.accuweather.com" )
			.get( "/locations/v1/cities/geoposition/search" )
			.query( true )
			.reply( 500, { message: "location service unavailable" } );

		const provider = new AccuWeatherWeatherProvider();
		const error = await expectCodedError(
			() => provider.getWateringData( [ 42.3732, -72.5199 ] ),
			ErrorCode.LocationServiceApiError
		);

		expect( error ).not.to.be.instanceOf( TypeError );
		expect( error.message ).not.to.match( /Key.*undefined|undefined.*Key/i );
	} );
} );

async function expectCodedError( action: () => Promise<unknown>, errCode: ErrorCode ): Promise<CodedError> {
	try {
		await action();
	} catch ( err ) {
		expect( err ).to.be.instanceOf( CodedError );
		const codedError = err as CodedError;
		expect( codedError.errCode ).to.equal( errCode );
		return codedError;
	}

	throw new Error( "Expected promise to reject with a CodedError." );
}
