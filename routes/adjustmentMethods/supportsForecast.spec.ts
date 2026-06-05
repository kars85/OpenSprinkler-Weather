import { expect } from "chai";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import { supportsForecast } from "./EToAdjustmentMethod";

describe( "EToAdjustmentMethod.supportsForecast (structural capability guard)", () => {
	it( "is false for a plain WeatherProvider", () => {
		expect( supportsForecast( new WeatherProvider() ) ).to.equal( false );
	} );

	it( "is true for any object exposing supportsForecasting()===true (e.g. the fallback composite)", () => {
		const capable: any = new WeatherProvider();
		capable.supportsForecasting = () => true;
		expect( supportsForecast( capable ) ).to.equal( true );
	} );

	it( "is false when supportsForecasting() returns false", () => {
		const incapable: any = new WeatherProvider();
		incapable.supportsForecasting = () => false;
		expect( supportsForecast( incapable ) ).to.equal( false );
	} );
} );
