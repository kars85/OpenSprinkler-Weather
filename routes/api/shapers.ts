import { GeoCoordinates } from "../../types";
import { WateringDecision, OsTimeFields } from "../weather";

export function shapeWateringResponse( d: WateringDecision, time?: OsTimeFields ): any {
	const raw = d.rawData || {};
	const out: any = {
		location: d.coordinates,
		method: d.methodName,
		methodName: d.methodName,
		methodId: d.methodId,
		scale: d.scale,
		rainDelay: d.rainDelay,
		skip: d.skip,
		skipReason: d.skipReason !== undefined ? d.skipReason : null,
		pwsBypassed: d.pwsBypassed,
		restricted: d.restricted,
		weatherProvider: d.weatherProvider,
		reason: raw.reason !== undefined ? raw.reason : null,
		raw: d.rawData
	};
	// Additive superset: carry the OS-encoded time fields the legacy response also emits
	// (tz/sunrise/sunset/eip) so a single /v1/watering call covers the full firmware effect-contract.
	if ( time ) {
		out.tz = time.tz;
		out.sunrise = time.sunrise;
		out.sunset = time.sunset;
		out.eip = time.eip;
	}
	return out;
}

export function shapeWeatherResponse( coordinates: GeoCoordinates, weather: any ): any {
	return {
		location: coordinates,
		weatherProvider: weather.weatherProvider,
		temp: weather.temp,
		humidity: weather.humidity,
		wind: weather.wind,
		precip: weather.precip,
		minTemp: weather.minTemp,
		maxTemp: weather.maxTemp,
		description: weather.description,
		icon: weather.icon
	};
}

export function shapeBudgetResponse( coordinates: GeoCoordinates, state: any, limit: number ): any {
	const history = ( state.history || [] ).slice( -limit ).map( ( r: any ) => {
		const out: any = {
			date: r.date, scale: r.scale, eto: r.eto, etc: r.etc,
			effectiveRain: r.effectiveRain, rainBankAfter: r.rainBankAfter, reason: r.reason
		};
		if ( r.kcSource !== undefined ) { out.kc = r.demandKc; out.kcSource = r.kcSource; }
		return out;
	} );
	return {
		location: coordinates,
		rainBank: state.rainBank,
		lastUpdated: state.lastUpdated,
		lastScale: state.lastScale,
		history
	};
}
