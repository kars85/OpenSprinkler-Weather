import moment from "moment";
import { expect } from "chai";
import { GeoCoordinates } from "../../types";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import EToAdjustmentMethod, { EToData } from "./EToAdjustmentMethod";

describe( "EToAdjustmentMethod crop-coefficient dispatch", () => {
	const coords: GeoCoordinates = [ 40.0, -105.0 ];
	const periodStartTime = moment.utc( "2024-07-15" ).unix(); // ~ peak day 196

	class StubEToProvider extends WeatherProvider {
		public async getEToData(): Promise< EToData > {
			return {
				weatherProvider: "mock" as any, precip: 0, periodStartTime,
				minTemp: 55, maxTemp: 85, minHumidity: 30, maxHumidity: 70,
				solarRadiation: 6, windSpeed: 5
			};
		}
	}

	it( "applies the customCropCoefficient override to rawData.crop_coefficient", async () => {
		const res: any = await EToAdjustmentMethod.calculateWateringScale(
			{ baseETo: 0.2, enableCropCoefficient: true, customCropCoefficient: 0.5 } as any, coords, new StubEToProvider()
		);
		expect( res.rawData.crop_coefficient ).to.equal( 0.5 );
		expect( res.rawData.crop_factors.source ).to.equal( "override" );
	} );

	it( "applies a plant preset's seasonal Kc when plantType is set", async () => {
		const res: any = await EToAdjustmentMethod.calculateWateringScale(
			{ baseETo: 0.2, enableCropCoefficient: true, plantType: "vegetable-garden" } as any, coords, new StubEToProvider()
		);
		// vegetable-garden peaks at 1.0 around day 196
		expect( res.rawData.crop_coefficient ).to.be.closeTo( 1.0, 0.05 );
		expect( res.rawData.crop_factors.source ).to.equal( "plant" );
		expect( res.rawData.crop_factors.plantType ).to.equal( "vegetable-garden" );
	} );
} );
