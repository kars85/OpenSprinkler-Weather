import { expect } from "chai";
import { WeatherData, ZimmermanWateringData } from "../../types";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import { EToData } from "./EToAdjustmentMethod";
import WaterBudgetAdjustmentMethod, { getBudgetState } from "./WaterBudgetAdjustmentMethod";

class StubProvider extends WeatherProvider {
	constructor( private readonly data: EToData ) { super(); }
	public async getWateringData(): Promise< ZimmermanWateringData > { throw new Error( "n/a" ); }
	public async getWeatherData(): Promise< WeatherData > { throw new Error( "n/a" ); }
	public async getEToData(): Promise< EToData > { return this.data; }
}

function etoData( over: Partial<EToData> = {} ): EToData {
	return {
		weatherProvider: "mock", periodStartTime: 1557705600,
		minTemp: 50, maxTemp: 80, minHumidity: 30, maxHumidity: 80,
		solarRadiation: 6, windSpeed: 4, precip: 0, ...over
	};
}
const opts = { provider: "mock" } as any;

function withEnv( vars: { [ k: string ]: string | undefined }, fn: () => Promise< void > ): Promise< void > {
	const saved: { [ k: string ]: string | undefined } = {};
	for ( const k of Object.keys( vars ) ) {
		saved[ k ] = process.env[ k ];
		if ( vars[ k ] === undefined ) delete process.env[ k ]; else process.env[ k ] = vars[ k ]!;
	}
	return fn().then( () => undefined ).finally( () => {
		for ( const k of Object.keys( saved ) ) {
			if ( saved[ k ] === undefined ) delete process.env[ k ]; else process.env[ k ] = saved[ k ]!;
		}
	} );
}

describe( "WaterBudget per-plant Kc", () => {
	it( "applies a per-request budgetKc override to demand and flags it", async () => {
		await withEnv( { BUDGET_PLANT_TYPE: undefined, BUDGET_CUSTOM_CROP_COEFFICIENT: undefined, BUDGET_KC: "0.9" }, async () => {
			const res: any = await WaterBudgetAdjustmentMethod.calculateWateringScale(
				{ ...opts, budgetKc: 0.4 } as any, [ 42.45, -72.45 ], new StubProvider( etoData() )
			);
			expect( res.rawData.kcSource ).to.equal( "override-budget" );
			expect( res.rawData.budgetKcApplied ).to.equal( true );
			expect( res.rawData.kc ).to.equal( 0.4 );
			expect( res.rawData.etc ).to.be.closeTo( res.rawData.eto * 0.4, 0.02 );
		} );
	} );

	it( "flags a late same-day budgetKc override without recomputing", async () => {
		await withEnv( { BUDGET_PLANT_TYPE: undefined, BUDGET_CUSTOM_CROP_COEFFICIENT: undefined, BUDGET_KC: "0.9" }, async () => {
			const coords: [ number, number ] = [ 42.46, -72.46 ];
			const first: any = await WaterBudgetAdjustmentMethod.calculateWateringScale(
				{ ...opts, budgetKc: 0.3 } as any, coords, new StubProvider( etoData() )
			);
			const second: any = await WaterBudgetAdjustmentMethod.calculateWateringScale(
				{ ...opts, budgetKc: 0.8 } as any, coords, new StubProvider( etoData({ minTemp: 70, maxTemp: 105, precip: 2 }) )
			);
			const state = await getBudgetState( coords );

			expect( second.scale ).to.equal( first.scale );
			expect( second.rawData.scale ).to.equal( first.rawData.scale );
			expect( second.rawData.kcSource ).to.equal( "override-budget" );
			expect( second.rawData.kc ).to.equal( 0.3 );
			expect( second.rawData.budgetKcApplied ).to.equal( false );
			expect( second.rawData.budgetKcLockedForToday ).to.equal( true );
			expect( second.rawData.reason ).to.contain( "locked for today" );
			expect( state!.history.length ).to.equal( 1 );
			expect( state!.history[ 0 ].demandKc ).to.equal( 0.3 );
		} );
	} );

	it( "falls back when per-request budgetKc is junk", async () => {
		await withEnv( { BUDGET_PLANT_TYPE: undefined, BUDGET_CUSTOM_CROP_COEFFICIENT: undefined, BUDGET_KC: "0.9" }, async () => {
			const blank: any = await WaterBudgetAdjustmentMethod.calculateWateringScale(
				{ ...opts, budgetKc: "" } as any, [ 42.47, -72.47 ], new StubProvider( etoData() )
			);
			const bool: any = await WaterBudgetAdjustmentMethod.calculateWateringScale(
				{ ...opts, budgetKc: false } as any, [ 42.48, -72.48 ], new StubProvider( etoData() )
			);
			const nan: any = await WaterBudgetAdjustmentMethod.calculateWateringScale(
				{ ...opts, budgetKc: NaN } as any, [ 42.49, -72.49 ], new StubProvider( etoData() )
			);

			for ( const res of [ blank, bool, nan ] ) {
				expect( res.rawData.kcSource ).to.equal( undefined );
				expect( res.rawData.budgetKcApplied ).to.equal( undefined );
				expect( res.rawData.etc ).to.be.closeTo( res.rawData.eto * 0.9, 0.02 );
			}
		} );
	} );

	it( "preserves a low but valid per-request budgetKc", async () => {
		await withEnv( { BUDGET_PLANT_TYPE: undefined, BUDGET_CUSTOM_CROP_COEFFICIENT: "0.9", BUDGET_KC: "0.9" }, async () => {
			const res: any = await WaterBudgetAdjustmentMethod.calculateWateringScale(
				{ ...opts, budgetKc: 0.2 } as any, [ 42.52, -72.52 ], new StubProvider( etoData() )
			);
			expect( res.rawData.kcSource ).to.equal( "override-budget" );
			expect( res.rawData.kc ).to.equal( 0.2 );
			expect( res.rawData.etc ).to.be.closeTo( res.rawData.eto * 0.2, 0.02 );
		} );
	} );

	it( "keeps no-override behavior unchanged", async () => {
		await withEnv( { BUDGET_PLANT_TYPE: undefined, BUDGET_CUSTOM_CROP_COEFFICIENT: undefined, BUDGET_KC: "0.9" }, async () => {
			const res: any = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, [ 42.53, -72.53 ], new StubProvider( etoData() ) );
			expect( res.rawData.kc ).to.equal( undefined );
			expect( res.rawData.kcSource ).to.equal( undefined );
			expect( res.rawData.budgetKcApplied ).to.equal( undefined );
			expect( res.rawData.etc ).to.be.closeTo( res.rawData.eto * 0.9, 0.02 );
		} );
	} );

	it( "applies a BUDGET_CUSTOM_CROP_COEFFICIENT override to demand and flags it", async () => {
		await withEnv( { BUDGET_PLANT_TYPE: undefined, BUDGET_CUSTOM_CROP_COEFFICIENT: "0.3" }, async () => {
			const res: any = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, [ 42.41, -72.41 ], new StubProvider( etoData() ) );
			expect( res.rawData.kcSource ).to.equal( "override" );
			expect( res.rawData.kc ).to.equal( 0.3 );
			expect( res.rawData.etc ).to.be.closeTo( res.rawData.eto * 0.3, 0.02 );
		} );
	} );

	it( "applies a BUDGET_PLANT_TYPE preset to demand and flags it", async () => {
		await withEnv( { BUDGET_CUSTOM_CROP_COEFFICIENT: undefined, BUDGET_PLANT_TYPE: "vegetable-garden" }, async () => {
			const res: any = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, [ 42.42, -72.42 ], new StubProvider( etoData() ) );
			expect( res.rawData.kcSource ).to.equal( "plant" );
			expect( res.rawData.kc ).to.be.within( 0.3, 1.01 );
			expect( res.rawData.etc ).to.be.closeTo( res.rawData.eto * res.rawData.kc, 0.02 );
		} );
	} );

	it( "adds no kc metadata when unconfigured (continuity)", async () => {
		await withEnv( { BUDGET_PLANT_TYPE: undefined, BUDGET_CUSTOM_CROP_COEFFICIENT: undefined }, async () => {
			const res: any = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, [ 42.43, -72.43 ], new StubProvider( etoData() ) );
			expect( res.rawData.kc ).to.equal( undefined );
			expect( res.rawData.kcSource ).to.equal( undefined );
		} );
	} );

	it( "falls back to reference kc (BUDGET_KC) for an invalid override with no plant", async () => {
		await withEnv( { BUDGET_PLANT_TYPE: undefined, BUDGET_CUSTOM_CROP_COEFFICIENT: "abc", BUDGET_KC: "0.9" }, async () => {
			const res: any = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, [ 42.44, -72.44 ], new StubProvider( etoData() ) );
			expect( res.rawData.kcSource ).to.equal( undefined ); // source "budget" => omitted
			expect( res.rawData.etc ).to.be.closeTo( res.rawData.eto * 0.9, 0.02 );
		} );
	} );
} );

describe( "WaterBudget getBudgetState", () => {
	it( "returns undefined for a location with no stored state", async () => {
		expect( await getBudgetState( [ 12.34, -56.78 ] ) ).to.equal( undefined );
	} );

	it( "returns the persisted state after a calculation", async () => {
		const coords: [ number, number ] = [ 42.51, -72.51 ];
		await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, coords, new StubProvider( etoData() ) );
		const state = await getBudgetState( coords );
		expect( state ).to.be.an( "object" );
		expect( state!.history.length ).to.be.greaterThan( 0 );
		expect( state!.lastScale ).to.be.a( "number" );
	} );
} );
