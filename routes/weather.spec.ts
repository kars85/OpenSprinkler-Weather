import { expect } from 'chai';
import * as nock from 'nock';
import * as MockExpressRequest from 'mock-express-request';
import * as MockExpressResponse from 'mock-express-response';
import * as MockDate from 'mockdate';

// The tests don't use OWM, but the WeatherProvider API key must be set to prevent an error from being thrown on startup.
process.env.WEATHER_PROVIDER = "OWM";
process.env.OWM_API_KEY = "NO_KEY";

import { getWateringData } from './weather';
import { GeoCoordinates, WeatherData, ZimmermanWateringData } from "../types";
import { WeatherProvider } from "./weatherProviders/WeatherProvider";
import { EToData } from "./adjustmentMethods/EToAdjustmentMethod";

const expected = require( '../test/expected.json' );
const replies = require( '../test/replies.json' );

const location = '01002';

describe('Watering Data', () => {
    beforeEach(() => MockDate.set('5/13/2019'));

    it('OpenWeatherMap Lookup (Adjustment Method 0, Location 01002)', async () => {
        mockGeocoder();
        mockOWM();

        const expressMocks = createExpressMocks(0, location);
        await getWateringData(expressMocks.request, expressMocks.response);
        expect( expressMocks.response._getJSON() ).to.eql( expected.noWeather[location] );
    });

    it('OpenWeatherMap Lookup (Adjustment Method 1, Location 01002)', async () => {
        mockGeocoder();
        mockOWMWatering();

        // Provider selection comes from the `wto` param (WEATHER_PROVIDER env is only honored
        // for "local"), so explicitly request the OWM provider.
        const expressMocks = createExpressMocks(1, location, '"provider":"OWM"');
        await getWateringData(expressMocks.request, expressMocks.response);
        expect( expressMocks.response._getJSON() ).to.eql( expected.adjustment1[location] );
    });

    it('Water Budget Lookup (Adjustment Method 4, Location 01002)', async () => {
        mockGeocoder();
        mockOWMWatering();

        const expressMocks = createExpressMocks(4, location, '"provider":"OWM"');
        await getWateringData(expressMocks.request, expressMocks.response);

        const body: any = expressMocks.response._getJSON();
        expect( body.scale ).to.be.a('number');
        expect( body.scale ).to.be.within(0, 200);
        expect( body.rawData ).to.be.an('object');
        expect( body.rawData.reason ).to.be.a('string').and.contain('Scale');
    });

    it('Water Budget Lookup (Adjustment Method 4) uses the cached same-day scale for caching providers', async () => {
        mockOpenMeteoETo();

        const expressMocksA = createExpressMocks(4, '42.3732,-72.5199', '"provider":"OpenMeteo"');
        await getWateringData(expressMocksA.request, expressMocksA.response);

        const expressMocksB = createExpressMocks(4, '42.3732,-72.5199', '"provider":"OpenMeteo"');
        await getWateringData(expressMocksB.request, expressMocksB.response);

        expect( expressMocksB.response._getJSON() ).to.eql( expressMocksA.response._getJSON() );
    });
});

function createExpressMocks(method: number, location: string, wto?: string) {
    // req.query is derived from the URL querystring by the mock, so encode wto into the URL.
    const wtoQuery = wto ? `&wto=${ encodeURIComponent( wto ) }` : "";
    const query: any = { loc: location, format: 'json' };
    if ( wto ) query.wto = wto;
    const request = new MockExpressRequest({
        method: 'GET',
        url: `/${method}?loc=${location}&format=json${ wtoQuery }`,
        query,
        params: [ method ],
        headers: {
            'x-forwarded-for': '127.0.0.1'
        }
    });

    return {
        request,
        response: new MockExpressResponse({
            request
        })
    }
}

function mockOWM() {
    nock( 'http://api.openweathermap.org' )
        .filteringPath( function() { return "/"; } )
        .get( "/" )
        .reply( 200, replies[location].OWMData );
}

function mockOWMWatering() {
    // The rewritten OWM provider's getWateringData makes two HTTPS requests:
    // the One Call `day_summary` (yesterday) and the One Call `current` (today).
    nock( 'https://api.openweathermap.org' )
        .get( '/data/3.0/onecall/day_summary' ).query( true )
        .reply( 200, replies[location].OWMDaySummary )
        .get( '/data/3.0/onecall' ).query( true )
        .reply( 200, replies[location].OWMToday );
}

function mockGeocoder() {
    // The default geocoder (WUnderground autocomplete) would otherwise make a live
    // network call to resolve "01002". Mock it to the canonical Amherst, MA coordinates
    // that the expected fixtures (tz/sunrise/sunset) were computed from.
    nock( 'http://autocomplete.wunderground.com' )
        .get( /.*/ )
        .reply( 200, { RESULTS: [ { lat: "42.3732", lon: "-72.5199", tz: "America/New_York" } ] } );
}

function mockOpenMeteoETo() {
    nock( 'https://api.open-meteo.com' )
        .get( '/v1/forecast' )
        .query( true )
        .once()
        .reply( 200, {
            hourly: {
                time: [
                    1557619200, 1557622800, 1557626400, 1557630000
                ],
                temperature_2m: [ 55, 65, 72, 60 ],
                relativehumidity_2m: [ 80, 60, 40, 70 ],
                precipitation: [ 0, 0.1, 0, 0 ],
                direct_radiation: [ 100, 250, 400, 150 ],
                windspeed_10m: [ 3, 5, 4, 2 ]
            }
        } );
}


/**
 * A WeatherProvider for testing purposes that returns weather data that is provided in the constructor.
 * This is a special WeatherProvider designed for testing purposes and should not be activated using the
 * WEATHER_PROVIDER environment variable.
 */
export class MockWeatherProvider extends WeatherProvider {

    private readonly mockData: MockWeatherData;

    public constructor(mockData: MockWeatherData) {
        super();
        this.mockData = mockData;
    }

    public async getWateringData( coordinates: GeoCoordinates ): Promise< ZimmermanWateringData > {
        return await this.getData( "wateringData" ) as ZimmermanWateringData;
    }

    public async getWeatherData( coordinates: GeoCoordinates ): Promise< WeatherData > {
        return await this.getData( "weatherData" ) as WeatherData;
    }

    public async getEToData( coordinates: GeoCoordinates ): Promise< EToData > {
        return await this.getData( "etoData" ) as EToData;
    }

    private async getData( type: "wateringData" | "weatherData" | "etoData" ) {
        const data = this.mockData[ type ];
        if ( !data.weatherProvider ) {
            data.weatherProvider = "mock";
        }

        return data;
    }
}

interface MockWeatherData {
    wateringData?: ZimmermanWateringData,
    weatherData?: WeatherData,
    etoData?: EToData
}
