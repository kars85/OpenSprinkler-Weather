import { expect } from "chai";
import { BudgetParams, BudgetState, daysBetween, HISTORY_CAP, step } from "./SoilMoistureModel";

const params: BudgetParams = {
	kc: 1.0, maxScale: 200, runoffFactor: 1.0, rainBankCapDays: 14, gapResetDays: 2
};

function input( over: Partial<{ today: string; eto: number; precip: number; referenceEto: number }> = {} ) {
	return {
		today: "2019-05-13", eto: 0.20, precip: 0, referenceEto: 0.20,
		resolvedLocation: undefined, params,
		...over
	};
}

describe( "SoilMoistureModel", () => {
	it( "daysBetween counts whole UTC days", () => {
		expect( daysBetween( "2019-05-13", "2019-05-16" ) ).to.equal( 3 );
		expect( daysBetween( "2019-05-13", "2019-05-13" ) ).to.equal( 0 );
	} );

	it( "normal dry day from cold start scales to 100%", () => {
		const { scale, state } = step( undefined, input() );
		expect( scale ).to.equal( 100 );
		expect( state.rainBank ).to.equal( 0 );
		expect( state.lastUpdated ).to.equal( "2019-05-13" );
	} );

	it( "hot dry day scales above 100% (clamped at maxScale)", () => {
		expect( step( undefined, input({ eto: 0.40 }) ).scale ).to.equal( 200 );
		expect( step( undefined, input({ eto: 1.0 }) ).scale ).to.equal( 200 );
	} );

	it( "a big rain bank covers demand and yields 0%, then drains over days", () => {
		const d1 = step( undefined, input({ today: "2019-05-13", precip: 1.0 }) );
		expect( d1.scale ).to.equal( 0 );
		expect( d1.state.rainBank ).to.be.closeTo( 0.80, 1e-9 );
		const d2 = step( d1.state, input({ today: "2019-05-14", precip: 0 }) );
		expect( d2.scale ).to.equal( 0 );
		expect( d2.state.rainBank ).to.be.closeTo( 0.60, 1e-9 );
	} );

	it( "after the bank drains, scale returns to 100%", () => {
		let s: BudgetState | undefined = undefined;
		s = step( s, input({ today: "2019-05-13", precip: 0.40 }) ).state;
		const day2 = step( s, input({ today: "2019-05-14" }) );
		expect( day2.scale ).to.equal( 0 );
		const day3 = step( day2.state, input({ today: "2019-05-15" }) );
		expect( day3.scale ).to.equal( 100 );
	} );

	it( "caps rain memory at rainBankCapDays * referenceETc", () => {
		const { state } = step( undefined, input({ precip: 100 }) );
		expect( state.rainBank ).to.equal( params.rainBankCapDays * 0.20 );
	} );

	it( "is idempotent for a same-day re-poll", () => {
		const first = step( undefined, input({ today: "2019-05-13", eto: 0.30 }) );
		const second = step( first.state, input({ today: "2019-05-13", eto: 0.99 }) );
		expect( second.scale ).to.equal( first.scale );
		expect( second.state ).to.equal( first.state );
	} );

	it( "resets rain memory after a gap longer than gapResetDays", () => {
		const seeded = step( undefined, input({ today: "2019-05-13", precip: 1.0 }) ).state;
		const afterGap = step( seeded, input({ today: "2019-05-20" }) );
		expect( afterGap.state.rainBank ).to.equal( 0 );
		expect( afterGap.scale ).to.equal( 100 );
		expect( afterGap.reason.toLowerCase() ).to.contain( "gap" );
	} );

	it( "bounds the history ring buffer at HISTORY_CAP", () => {
		let s: BudgetState | undefined = undefined;
		for ( let i = 0; i < HISTORY_CAP + 25; i++ ) {
			const day = "2019-" + String( 1 + Math.floor( i / 28 ) ).padStart( 2, "0" ) + "-" + String( 1 + ( i % 28 ) ).padStart( 2, "0" );
			s = step( s, input({ today: day }) ).state;
		}
		expect( s!.history.length ).to.equal( HISTORY_CAP );
	} );

	it( "never returns a scale outside [0, maxScale]", () => {
		expect( step( undefined, input({ eto: -5 }) ).scale ).to.equal( 0 );
		expect( step( undefined, input({ eto: 999 }) ).scale ).to.equal( 200 );
	} );

	it( "treats negative ETo as zero demand and never inflates the rain bank", () => {
		const d1 = step( undefined, input({ today: "2019-05-13", eto: -0.5, precip: 0 }) );
		expect( d1.scale ).to.equal( 0 );
		expect( d1.state.rainBank ).to.equal( 0 );
		const seeded = step( undefined, input({ today: "2019-05-13", precip: 0.40 }) ).state;
		const d2 = step( seeded, input({ today: "2019-05-14", eto: -0.5, precip: 0 }) );
		expect( d2.state.rainBank ).to.be.at.most( seeded.rainBank );
	} );

	it( "never emits NaN from non-finite inputs (no corrupted bank)", () => {
		const r = step( undefined, input({ eto: NaN, precip: NaN, referenceEto: NaN }) );
		expect( Number.isFinite( r.scale ) ).to.equal( true );
		expect( Number.isFinite( r.state.rainBank ) ).to.equal( true );
		// A malformed prior bank (NaN) must be treated as 0, not propagated.
		const bad = { rainBank: NaN, lastUpdated: "2019-05-12", lastScale: 0, history: [] } as any;
		const r2 = step( bad, input({ today: "2019-05-13" }) );
		expect( Number.isFinite( r2.state.rainBank ) ).to.equal( true );
	} );
} );
