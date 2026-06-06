import { expect } from "chai";
import { WeatherData, ZimmermanWateringData } from "../../types";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import { EToData } from "./EToAdjustmentMethod";
import WaterBudgetAdjustmentMethod from "./WaterBudgetAdjustmentMethod";

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
