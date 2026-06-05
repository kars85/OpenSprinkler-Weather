import { expect } from "chai";
import { GeoCoordinates, PWS, WeatherData, ZimmermanWateringData } from "../../types";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import { EToData } from "./EToAdjustmentMethod";
import { CodedError, ErrorCode } from "../../errors";
import WaterBudgetAdjustmentMethod from "./WaterBudgetAdjustmentMethod";
import { ADJUSTMENT_METHOD } from "../weather";

class StubProvider extends WeatherProvider {
	constructor( private readonly data: EToData | null, private readonly fail = false ) { super(); }
	public async getWateringData(): Promise< ZimmermanWateringData > { throw new Error( "n/a" ); }
	public async getWeatherData(): Promise< WeatherData > { throw new Error( "n/a" ); }
	public async getEToData(): Promise< EToData > {
		if ( this.fail ) throw new CodedError( ErrorCode.WeatherApiError );
		return this.data as EToData;
	}
}

function etoData( over: Partial<EToData> = {} ): EToData {
	return {
		weatherProvider: "mock", periodStartTime: 1557705600,
		minTemp: 50, maxTemp: 80, minHumidity: 30, maxHumidity: 80,
		solarRadiation: 6, windSpeed: 4, precip: 0, ...over
	};
}

const opts = { provider: "mock" } as any;

describe( "WaterBudgetAdjustmentMethod", () => {
	it( "returns a numeric scale in [0,200] with a reason in rawData", async () => {
		const res = await WaterBudgetAdjustmentMethod.calculateWateringScale(
			opts, [ 42.10, -72.10 ], new StubProvider( etoData() )
		);
		expect( res.scale ).to.be.a( "number" );
		expect( res.scale! ).to.be.within( 0, 200 );
		expect( ( res.rawData as any ).reason ).to.be.a( "string" ).and.contain( "Scale" );
	} );

	it( "yields 0% on a heavy-rain day (rain covers demand regardless of ET)", async () => {
		const res = await WaterBudgetAdjustmentMethod.calculateWateringScale(
			opts, [ 42.11, -72.11 ], new StubProvider( etoData({ precip: 5 }) )
		);
		expect( res.scale ).to.equal( 0 );
	} );

	it( "persists state across calls for the same location (rain memory)", async () => {
		const coords: GeoCoordinates = [ 42.12, -72.12 ];
		await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, coords, new StubProvider( etoData({ precip: 5 }) ) );
		const day2 = await WaterBudgetAdjustmentMethod.calculateWateringScale(
			opts, coords, new StubProvider( etoData({ periodStartTime: 1557792000, precip: 0 }) )
		);
		expect( day2.scale ).to.equal( 0 );
	} );

	it( "is idempotent for a same-day re-poll", async () => {
		const coords: GeoCoordinates = [ 42.13, -72.13 ];
		const a = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, coords, new StubProvider( etoData() ) );
		const b = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, coords, new StubProvider( etoData({ minTemp: 10, maxTemp: 110 }) ) );
		expect( b.scale ).to.equal( a.scale );
	} );

	it( "reuses the stored rawData inputs on a same-day re-poll", async () => {
		const coords: GeoCoordinates = [ 42.131, -72.131 ];
		const a = await WaterBudgetAdjustmentMethod.calculateWateringScale(
			opts,
			coords,
			new StubProvider( etoData({ precip: 0.4, solarRadiation: 6 }) )
		);
		const b = await WaterBudgetAdjustmentMethod.calculateWateringScale(
			opts,
			coords,
			new StubProvider( etoData({ precip: 1.9, solarRadiation: 10, minTemp: 10, maxTemp: 110 }) )
		);
		expect( b.scale ).to.equal( a.scale );
		expect( ( b.rawData as any ).eto ).to.equal( ( a.rawData as any ).eto );
		expect( ( b.rawData as any ).etc ).to.equal( ( a.rawData as any ).etc );
		expect( ( b.rawData as any ).p ).to.equal( ( a.rawData as any ).p );
	} );

	it( "holds the last scale (flagged stale) when weather fails but state exists", async () => {
		const coords: GeoCoordinates = [ 42.14, -72.14 ];
		const good = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, coords, new StubProvider( etoData() ) );
		const stale = await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, coords, new StubProvider( null, true ) );
		expect( stale.scale ).to.equal( good.scale );
		expect( ( stale.rawData as any ).reason.toLowerCase() ).to.contain( "stale" );
	} );

	it( "throws a CodedError when weather fails with no prior state", async () => {
		let threw: any;
		try {
			await WaterBudgetAdjustmentMethod.calculateWateringScale( opts, [ 9.99, 9.99 ], new StubProvider( null, true ) );
		} catch ( e ) { threw = e; }
		expect( threw ).to.be.instanceOf( CodedError );
	} );

	it( "honors BUDGET_RUNOFF=0 so rain does not reduce the scale", async () => {
		const previous = process.env.BUDGET_RUNOFF;
		process.env.BUDGET_RUNOFF = "0";
		try {
			const dry = await WaterBudgetAdjustmentMethod.calculateWateringScale(
				opts, [ 42.141, -72.141 ], new StubProvider( etoData({ precip: 0 }) )
			);
			const rainy = await WaterBudgetAdjustmentMethod.calculateWateringScale(
				opts, [ 42.142, -72.142 ], new StubProvider( etoData({ precip: 3 }) )
			);
			expect( rainy.scale ).to.equal( dry.scale );
		} finally {
			if ( previous === undefined ) delete process.env.BUDGET_RUNOFF;
			else process.env.BUDGET_RUNOFF = previous;
		}
	} );
} );

describe( "WaterBudget registration", () => {
	it( "is registered as adjustment method 4", () => {
		expect( ADJUSTMENT_METHOD[ 4 ] ).to.equal( WaterBudgetAdjustmentMethod );
	} );
} );
