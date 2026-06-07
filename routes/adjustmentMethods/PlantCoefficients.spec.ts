import { expect } from "chai";
import { clampKc, getPlantKc, KC_MAX, KC_MIN, PLANT_KC_CATALOG, resolveCropCoefficient } from "./PlantCoefficients";

describe( "PlantCoefficients.clampKc", () => {
	it( "returns a finite value clamped to [0.1, 1.5]", () => {
		expect( clampKc( 0.65 ) ).to.equal( 0.65 );
		expect( clampKc( 5 ) ).to.equal( KC_MAX );
		expect( clampKc( -2 ) ).to.equal( KC_MIN );
		expect( clampKc( "0.8" ) ).to.equal( 0.8 );
	} );
	it( "returns undefined for non-finite input", () => {
		expect( clampKc( undefined ) ).to.equal( undefined );
		expect( clampKc( NaN ) ).to.equal( undefined );
		expect( clampKc( "abc" ) ).to.equal( undefined );
		expect( clampKc( null ) ).to.equal( undefined );
		expect( clampKc( "" ) ).to.equal( undefined );
		expect( clampKc( "   " ) ).to.equal( undefined );
		expect( clampKc( false ) ).to.equal( undefined );
		expect( clampKc( true ) ).to.equal( undefined );
	} );
} );

describe( "PlantCoefficients.getPlantKc", () => {
	it( "peaks at the summer peak day and bottoms half a year away", () => {
		const peak = getPlantKc( "vegetable-garden", 196 );
		const trough = getPlantKc( "vegetable-garden", 14 ); // ~182 days from peak
		expect( peak ).to.equal( 1.0 );
		expect( trough ).to.be.closeTo( 0.30, 0.02 );
		expect( peak ).to.be.greaterThan( trough );
	} );
	it( "stays within [dormantKc, peakKc] and global bounds for every catalog entry across the year", () => {
		for ( const key of Object.keys( PLANT_KC_CATALOG ) ) {
			const { dormantKc, peakKc } = PLANT_KC_CATALOG[ key ];
			for ( let d = 1; d <= 365; d += 30 ) {
				const kc = getPlantKc( key, d );
				expect( kc, `${ key }@${ d }` ).to.be.within( dormantKc - 0.01, peakKc + 0.01 );
				expect( kc ).to.be.within( KC_MIN, KC_MAX );
			}
		}
	} );
	it( "returns 1.0 for an unknown plant type", () => {
		expect( getPlantKc( "spaceship", 100 ) ).to.equal( 1.0 );
	} );
} );

describe( "PlantCoefficients.resolveCropCoefficient", () => {
	const turf = (): any => ( { kc: 0.85, factors: { source: "turf" } } );

	it( "override wins over plant and turf (clamped)", () => {
		const r = resolveCropCoefficient( { customCropCoefficient: 0.5, plantType: "trees" }, 196, turf, {} );
		expect( r.kc ).to.equal( 0.5 );
		expect( r.factors.source ).to.equal( "override" );
	} );

	it( "a non-finite override falls through to the plant preset", () => {
		const r = resolveCropCoefficient( { customCropCoefficient: NaN, plantType: "vegetable-garden" }, 196, turf, {} );
		expect( r.kc ).to.equal( 1.0 );
		expect( r.factors.source ).to.equal( "plant" );
	} );

	it( "a known plantType wins over turf", () => {
		const r = resolveCropCoefficient( { plantType: "native" }, 196, turf, {} );
		expect( r.factors ).to.deep.equal( { source: "plant", plantType: "native" } );
	} );

	it( "an unknown plantType falls through to turf", () => {
		const r = resolveCropCoefficient( { plantType: "spaceship" }, 196, turf, {} );
		expect( r.factors.source ).to.equal( "turf" );
		expect( r.kc ).to.equal( 0.85 );
	} );

	it( "no override and no plantType uses the turf fallback", () => {
		const r = resolveCropCoefficient( {}, 196, turf, {} );
		expect( r.factors.source ).to.equal( "turf" );
	} );

	it( "reads env CUSTOM_CROP_COEFFICIENT and PLANT_TYPE when opts are absent", () => {
		expect( resolveCropCoefficient( {}, 196, turf, { CUSTOM_CROP_COEFFICIENT: "0.7" } ).kc ).to.equal( 0.7 );
		expect( resolveCropCoefficient( {}, 196, turf, { PLANT_TYPE: "trees" } ).factors.source ).to.equal( "plant" );
	} );
} );
