import { expect } from "chai";
import * as MockDate from "mockdate";
import ForecastCache from "./ForecastCache";

const H = 60 * 60 * 1000;

describe( "ForecastCache", () => {
	afterEach( () => MockDate.reset() );

	it( "serves a fresh entry within the fresh TTL", () => {
		MockDate.set( "2026-06-11T00:00:00Z" );
		const c = new ForecastCache< number[] >( 3 * H, 6 * H );
		c.set( "k", [ 1, 2, 3 ] );
		MockDate.set( "2026-06-11T02:00:00Z" );          // +2h, within 3h fresh TTL
		expect( c.getFresh( "k" ) ).to.deep.equal( [ 1, 2, 3 ] );
		expect( c.get( "k" )!.fresh ).to.equal( true );
	} );

	it( "treats an entry past the fresh TTL as stale (getFresh undefined, getStale returns)", () => {
		MockDate.set( "2026-06-11T00:00:00Z" );
		const c = new ForecastCache< number[] >( 3 * H, 6 * H );
		c.set( "k", [ 9 ] );
		MockDate.set( "2026-06-11T04:00:00Z" );          // +4h: past fresh (3h), within stale (6h)
		expect( c.getFresh( "k" ) ).to.equal( undefined );
		expect( c.getStale( "k" ) ).to.deep.equal( [ 9 ] );
		expect( c.get( "k" )!.fresh ).to.equal( false );
	} );

	it( "evicts an entry past the stale window", () => {
		MockDate.set( "2026-06-11T00:00:00Z" );
		const c = new ForecastCache< number[] >( 3 * H, 6 * H );
		c.set( "k", [ 9 ] );
		MockDate.set( "2026-06-11T07:00:00Z" );          // +7h: past stale (6h)
		expect( c.getStale( "k" ) ).to.equal( undefined );
		expect( c.get( "k" ) ).to.equal( undefined );
	} );

	it( "returns undefined for unknown keys", () => {
		const c = new ForecastCache();
		expect( c.get( "nope" ) ).to.equal( undefined );
		expect( c.getFresh( "nope" ) ).to.equal( undefined );
	} );

	it( "set() refreshes the age so a stale entry becomes fresh again", () => {
		MockDate.set( "2026-06-11T00:00:00Z" );
		const c = new ForecastCache< number[] >( 3 * H, 6 * H );
		c.set( "k", [ 1 ] );
		MockDate.set( "2026-06-11T04:00:00Z" );
		expect( c.getFresh( "k" ) ).to.equal( undefined ); // stale
		c.set( "k", [ 2 ] );                                // refreshed
		expect( c.getFresh( "k" ) ).to.deep.equal( [ 2 ] );
	} );
} );
