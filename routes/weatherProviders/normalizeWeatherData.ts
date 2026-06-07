import { WeatherData } from "../../types";
import { asFiniteNumber } from "./brandedNumbers";

const NUMERIC_WEATHER_DATA_FIELDS = [ "temp", "humidity", "wind", "minTemp", "maxTemp", "precip" ];

function describeValue( value: any ): string {
	if ( typeof value === "number" && Number.isNaN( value ) ) return "NaN";
	try {
		return JSON.stringify( value );
	} catch ( err ) {
		return String( value );
	}
}

/**
 * Normalize top-level numeric WeatherData fields without mutating provider output.
 * Malformed safety-critical fields are surfaced via contractViolations and must never be silently treated as below-threshold/no-rain; enforcement of caution-skip is deferred to the provider-routing pass (P2).
 */
export function normalizeWeatherData( provider: string, raw: WeatherData ): WeatherData {
	const normalized: WeatherData = Object.assign( {}, raw );
	let violations = raw.contractViolations ? raw.contractViolations.slice() : undefined;

	for ( const field of NUMERIC_WEATHER_DATA_FIELDS ) {
		const value = ( raw as any )[ field ];
		if ( asFiniteNumber( value ) ) {
			( normalized as any )[ field ] = value;
		} else if ( value === undefined || value === null ) {
			( normalized as any )[ field ] = undefined;
		} else {
			const renderedValue = describeValue( value );
			const violation = `WeatherData contract violation from ${ provider }: ${ field } must be a finite number or absent; got ${ renderedValue }`;
			if ( !violations ) violations = [];
			violations.push( violation );
			console.warn( violation );
			( normalized as any )[ field ] = NaN;
		}
	}

	if ( violations && violations.length > 0 ) normalized.contractViolations = violations;
	else delete normalized.contractViolations;

	return normalized;
}
