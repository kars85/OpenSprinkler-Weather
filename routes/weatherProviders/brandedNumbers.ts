import { WeatherData } from "../../types";

export type FiniteNumber = number & { readonly __finiteBrand: unique symbol };

export function asFiniteNumber( x: unknown ): x is FiniteNumber {
	return typeof x === "number" && Number.isFinite( x );
}

export type NormalizedWeatherData = Omit< WeatherData, "temp" | "humidity" | "wind" | "minTemp" | "maxTemp" | "precip" > & {
	temp: FiniteNumber;
	humidity: FiniteNumber;
	wind: FiniteNumber;
	minTemp: FiniteNumber;
	maxTemp: FiniteNumber;
	precip: FiniteNumber;
};
