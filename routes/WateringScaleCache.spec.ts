import { expect } from "chai";
import * as MockDate from "mockdate";
import WateringScaleCache, { CachedScale } from "../WateringScaleCache";
import { GeoCoordinates } from "../types";

describe( "WateringScaleCache", () => {
	afterEach( () => MockDate.reset() );

	it( "returns a hit for matching calculation inputs and a miss for a different method", () => {
		MockDate.set( "2026-06-05T16:00:00Z" );

		const cache = new WateringScaleCache();
		const coordinates: GeoCoordinates = [ 42.3732, -72.5199 ];
		const adjustmentOptions = { provider: "OpenMeteo", elevation: 500 } as any;
		const cachedScale: CachedScale = {
			scale: 87,
			rawData: { wp: "WaterBudget", reason: "cached" },
			rainDelay: 0
		};

		cache.storeWateringScale( 4, coordinates, undefined, adjustmentOptions, cachedScale );

		expect( cache.getWateringScale( 4, coordinates, undefined, adjustmentOptions ) ).to.deep.equal( cachedScale );
		expect( cache.getWateringScale( 3, coordinates, undefined, adjustmentOptions ) ).to.equal( undefined );
	} );
} );
