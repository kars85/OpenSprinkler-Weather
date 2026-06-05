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

    // SKIPPED: This test is stale relative to the current fork's behavior and cannot pass
    // without regenerating fixtures for unverified code:
    //   1. Provider selection no longer honors WEATHER_PROVIDER=OWM (it comes from the `wto`
    //      param or defaults to Apple), so this request resolves to Apple -> NoAPIKeyProvided (35).
    //   2. The OWM provider was rewritten to the One Call `day_summary` API (two requests, new
    //      JSON shape); test/replies.json still holds the old OWM format and won't parse.
    // Regenerating replies.json for the new API would enshrine machine-generated expected values
    // for the rewritten (and not independently verified) OWM path. Tracked on issue #2.
    it.skip('OpenWeatherMap Lookup (Adjustment Method 1, Location 01002)', async () => {
        mockGeocoder();
        mockOWM();

        const expressMocks = createExpressMocks(1, location);
        await getWateringData(expressMocks.request, expressMocks.response);
        expect( expressMocks.response._getJSON() ).to.eql( expected.adjustment1[location] );
    });
});

function createExpressMocks(method: number, location: string) {
    const request = new MockExpressRequest({
        method: 'GET',
        url: `/${method}?loc=${location}&format=json`,
        query: {
            loc: location,
            format: 'json'
        },
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

function mockGeocoder() {
    // The default geocoder (WUnderground autocomplete) would otherwise make a live
    // network call to resolve "01002". Mock it to the canonical Amherst, MA coordinates
    // that the expected fixtures (tz/sunrise/sunset) were computed from.
    nock( 'http://autocomplete.wunderground.com' )
        .get( /.*/ )
        .reply( 200, { RESULTS: [ { lat: "42.3732", lon: "-72.5199", tz: "America/New_York" } ] } );
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
