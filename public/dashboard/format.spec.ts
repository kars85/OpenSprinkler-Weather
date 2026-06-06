import { expect } from "chai";
const F = require( "./format.js" );

function memStore() {
	const m: { [ k: string ]: string } = {};
	return { getItem: ( k: string ) => ( k in m ? m[ k ] : null ), setItem: ( k: string, v: string ) => { m[ k ] = v; } };
}

describe( "dashboard format.parseParams", () => {
	it( "prefers URL, then store, then defaults; persists resolved values", () => {
		const s = memStore();
		expect( F.parseParams( "?loc=1,2&method=3", s ) ).to.deep.equal( { loc: "1,2", method: 3 } );
		expect( s.getItem( "osw_loc" ) ).to.equal( "1,2" );
		expect( F.parseParams( "", s ) ).to.deep.equal( { loc: "1,2", method: 3 } ); // store fallback
	} );
	it( "defaults method to 4 and rejects invalid/out-of-range", () => {
		expect( F.parseParams( "?loc=x", memStore() ).method ).to.equal( 4 );
		expect( F.parseParams( "?loc=x&method=9", memStore() ).method ).to.equal( 4 );
		expect( F.parseParams( "?loc=x&method=abc", memStore() ).method ).to.equal( 4 );
	} );
} );

describe( "dashboard format.buildRequestUrls", () => {
	it( "encodes loc and builds the three urls", () => {
		const u = F.buildRequestUrls( { loc: "42.3,-72.5", method: 4 } );
		expect( u.watering ).to.equal( "/v1/watering?loc=42.3%2C-72.5&method=4" );
		expect( u.weather ).to.equal( "/v1/weather?loc=42.3%2C-72.5" );
		expect( u.budget ).to.equal( "/v1/budget?loc=42.3%2C-72.5" );
	} );
} );

describe( "dashboard format.buildViewModel", () => {
	it( "maps watering/weather and budget history", () => {
		const vm = F.buildViewModel( {
			watering: { scale: 80, rainDelay: 0, methodName: "waterBudget", skip: false, reason: "dry", weatherProvider: "OWM", pwsBypassed: false },
			weather: { temp: 70, humidity: 50, wind: 5, precip: 0, minTemp: 60, maxTemp: 80, description: "Clear", weatherProvider: "OWM" },
			budget: { rainBank: 0.5, history: [ { date: "2024-07-15", scale: 80, reason: "dry" } ] }
		} );
		expect( vm.watering.scale ).to.equal( 80 );
		expect( vm.weather.temp ).to.equal( 70 );
		expect( vm.history ).to.deep.equal( [ 80 ] );
		expect( vm.decisions[ 0 ].reason ).to.equal( "dry" );
		expect( vm.budgetEmpty ).to.equal( false );
	} );
	it( "treats budget 404/absent as empty (not error)", () => {
		const vm = F.buildViewModel( { watering: { scale: 100 }, weather: {}, budget: { error: { code: "no_budget_state" } } } );
		expect( vm.budgetEmpty ).to.equal( true );
		expect( vm.history ).to.deep.equal( [] );
		expect( vm.decisions ).to.deep.equal( [] );
	} );
	it( "surfaces a watering error message without throwing", () => {
		const vm = F.buildViewModel( { watering: { error: { message: "bad loc" } }, weather: {}, budget: null } );
		expect( vm.watering.error ).to.equal( "bad loc" );
	} );
} );

describe( "dashboard format.buildHistoryPath", () => {
	it( "empty -> no points", () => { expect( F.buildHistoryPath( [], 100, 50 ) ).to.deep.equal( { points: "", min: 0, max: 0 } ); } );
	it( "single -> centered", () => { expect( F.buildHistoryPath( [ 80 ], 100, 50 ).points ).to.equal( "50,25" ); } );
	it( "all-equal -> midline, no NaN", () => {
		const r = F.buildHistoryPath( [ 5, 5, 5 ], 100, 50 );
		expect( r.points.indexOf( "NaN" ) ).to.equal( -1 );
		expect( r.min ).to.equal( 5 ); expect( r.max ).to.equal( 5 );
	} );
	it( "non-finite coerced (no NaN)", () => {
		expect( F.buildHistoryPath( [ NaN, 10 ] as any, 100, 50 ).points.indexOf( "NaN" ) ).to.equal( -1 );
	} );
	it( "monotonic series maps min->bottom, max->top", () => {
		expect( F.buildHistoryPath( [ 0, 100 ], 100, 50 ).points ).to.equal( "2,48 98,2" );
	} );
} );
