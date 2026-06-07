import { expect } from "chai";
import { asFiniteNumber, FiniteNumber } from "./brandedNumbers";

describe( "brandedNumbers", () => {
	describe( "asFiniteNumber", () => {
		it( "returns true for finite numbers", () => {
			for ( const value of [ 0, -2, 0.65, 100 ] ) {
				expect( asFiniteNumber( value ) ).to.equal( true );
			}
		} );

		it( "returns false for non-finite and non-number values", () => {
			for ( const value of [ NaN, Infinity, -Infinity, "Light", "0.5", null, undefined, {} ] ) {
				expect( asFiniteNumber( value ) ).to.equal( false );
			}
		} );

		it( "narrows unknown values to FiniteNumber", () => {
			const value: unknown = 0.65;
			if ( !asFiniteNumber( value ) ) throw new Error( "expected finite number" );

			const narrowed: FiniteNumber = value;
			expect( narrowed ).to.equal( 0.65 );
		} );
	} );
} );
