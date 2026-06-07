import { expect } from 'chai';
import * as nock from 'nock';
import * as MockExpressRequest from 'mock-express-request';
import * as MockExpressResponse from 'mock-express-response';
import * as MockDate from 'mockdate';

process.env.WEATHER_PROVIDER = "OWM";
process.env.OWM_API_KEY = "NO_KEY";

import { v1Budget, v1Watering, v1Weather } from './index';
import WaterBudgetAdjustmentMethod from '../adjustmentMethods/WaterBudgetAdjustmentMethod';
import { WeatherProvider } from '../weatherProviders/WeatherProvider';
import { EToData } from '../adjustmentMethods/EToAdjustmentMethod';

const replies = require( '../../test/replies.json' );
const COORDS = '42.3732,-72.5199';

function mockOWMWatering() {
	nock( 'https://api.openweathermap.org' )
		.get( '/data/3.0/onecall/day_summary' ).query( true ).reply( 200, replies[ '01002' ].OWMDaySummary )
		.get( '/data/3.0/onecall' ).query( true ).reply( 200, replies[ '01002' ].OWMToday );
}

function reqRes( query: any ) {
	const request = new MockExpressRequest( { method: 'GET', url: '/v1/watering', query } );
	return { request, response: new MockExpressResponse( { request } ) };
}

describe( '/v1/watering', () => {
	beforeEach( () => MockDate.set( '5/13/2019' ) );
	afterEach( () => { MockDate.reset(); nock.cleanAll(); } );

	it( 'returns a clean watering decision with no legacy fields', async () => {
		mockOWMWatering();
		const { request, response } = reqRes( { loc: COORDS, method: '1', provider: 'OWM' } );
		await v1Watering( request, response );
		const body: any = response._getJSON();
		expect( response.statusCode ).to.equal( 200 );
		expect( body.methodId ).to.equal( 1 );
		expect( body.methodName ).to.equal( 'zimmerman' );
		expect( body.scale ).to.be.a( 'number' );
		expect( body.weatherProvider ).to.be.a( 'string' );
		expect( body.location ).to.eql( [ 42.3732, -72.5199 ] );
		// No legacy-shaped fields.
		for ( const k of [ 'errCode', 'rd', 'tz', 'sunrise', 'eip' ] ) {
			expect( body[ k ], `legacy field ${ k } leaked` ).to.equal( undefined );
		}
	} );

	it( 'rejects a missing method with 400', async () => {
		const { request, response } = reqRes( { loc: COORDS } );
		await v1Watering( request, response );
		expect( response.statusCode ).to.equal( 400 );
		expect( response._getJSON().error.code ).to.equal( 'bad_request' );
	} );

	it( 'rejects an out-of-range method with 400', async () => {
		const { request, response } = reqRes( { loc: COORDS, method: '9' } );
		await v1Watering( request, response );
		expect( response.statusCode ).to.equal( 400 );
	} );

	it( 'maps a provider/weather failure to 502', async () => {
		nock( 'https://api.openweathermap.org' ).get( /.*/ ).query( true ).reply( 500 );
		const { request, response } = reqRes( { loc: COORDS, method: '1', provider: 'OWM' } );
		await v1Watering( request, response );
		expect( response.statusCode ).to.equal( 502 );
		expect( response._getJSON().error ).to.be.an( 'object' );
	} );
} );

describe( '/v1/weather', () => {
	afterEach( () => nock.cleanAll() );

	function mockOWMWeather() {
		nock( 'https://api.openweathermap.org' )
			.get( '/data/3.0/onecall' ).query( true )
			.reply( 200, {
				current: { temp: 72, humidity: 55, wind_speed: 6, weather: [ { id: 800, main: 'Clear', description: 'clear sky', icon: '01d' } ] },
				daily: [ { dt: 1557705600, temp: { min: 60, max: 80 }, rain: 0, weather: [ { id: 800, main: 'Clear', description: 'clear sky', icon: '01d' } ] } ]
			} );
	}

	it( 'returns clean current conditions', async () => {
		mockOWMWeather();
		const request = new MockExpressRequest( { method: 'GET', url: '/v1/weather', query: { loc: COORDS, provider: 'OWM' } } );
		const response = new MockExpressResponse( { request } );
		await v1Weather( request, response );
		const body: any = response._getJSON();
		expect( response.statusCode ).to.equal( 200 );
		expect( body.location ).to.eql( [ 42.3732, -72.5199 ] );
		expect( body.temp ).to.be.a( 'number' );
		expect( body.weatherProvider ).to.be.a( 'string' );
		for ( const k of [ 'errCode', 'tz', 'sunrise', 'eip' ] ) {
			expect( body[ k ], `legacy field ${ k } leaked` ).to.equal( undefined );
		}
	} );

	it( 'rejects a missing loc with 400', async () => {
		const request = new MockExpressRequest( { method: 'GET', url: '/v1/weather', query: {} } );
		const response = new MockExpressResponse( { request } );
		await v1Weather( request, response );
		expect( response.statusCode ).to.equal( 400 );
	} );
} );

describe( '/v1/budget', () => {
	class BudgetStub extends WeatherProvider {
		public async getEToData(): Promise< EToData > {
			return {
				weatherProvider: 'mock' as any, periodStartTime: 1557705600, precip: 0,
				minTemp: 50, maxTemp: 80, minHumidity: 30, maxHumidity: 80, solarRadiation: 6, windSpeed: 4
			};
		}
	}
	function budgetReq( query: any ) {
		const request = new MockExpressRequest( { method: 'GET', url: '/v1/budget', query } );
		return { request, response: new MockExpressResponse( { request } ) };
	}

	it( 'returns 404 when no budget state exists for the location', async () => {
		const { request, response } = budgetReq( { loc: '13.13,-13.13' } );
		await v1Budget( request, response );
		expect( response.statusCode ).to.equal( 404 );
		expect( response._getJSON().error.code ).to.equal( 'no_budget_state' );
	} );

	it( 'returns the stored bank + capped history after a calculation', async () => {
		const coords = '42.61,-72.61';
		await WaterBudgetAdjustmentMethod.calculateWateringScale( { provider: 'mock' } as any, [ 42.61, -72.61 ], new BudgetStub() );
		const { request, response } = budgetReq( { loc: coords, limit: '5' } );
		await v1Budget( request, response );
		const body: any = response._getJSON();
		expect( response.statusCode ).to.equal( 200 );
		expect( body.location ).to.eql( [ 42.61, -72.61 ] );
		expect( body.rainBank ).to.be.a( 'number' );
		expect( body.lastScale ).to.be.a( 'number' );
		expect( body.history ).to.be.an( 'array' );
		expect( body.history.length ).to.be.at.most( 5 );
		expect( body.history[ 0 ].reason ).to.be.a( 'string' );
	} );
} );
