import * as express from "express";
import * as http from "http";
import * as https from "https";
import * as SunCalc from "suncalc";
import * as moment from "moment-timezone";
import * as geoTZ from "geo-tz";
import { ParsedQs } from "qs";

import { BaseWateringData, GeoCoordinates, PWS, TimeData, WeatherData } from "../types";
import { WeatherProvider } from "./weatherProviders/WeatherProvider";
import { AdjustmentMethod, AdjustmentMethodResponse, AdjustmentOptions } from "./adjustmentMethods/AdjustmentMethod";
import WateringScaleCache, { CachedScale } from "../WateringScaleCache";
import ManualAdjustmentMethod from "./adjustmentMethods/ManualAdjustmentMethod";
import ZimmermanAdjustmentMethod from "./adjustmentMethods/ZimmermanAdjustmentMethod";
import RainDelayAdjustmentMethod from "./adjustmentMethods/RainDelayAdjustmentMethod";
import EToAdjustmentMethod from "./adjustmentMethods/EToAdjustmentMethod";
import { CodedError, ErrorCode, makeCodedError } from "../errors";
import { Geocoder } from "./geocoders/Geocoder";

const WEATHER_PROVIDERS: { [method: string] : WeatherProvider} = {
	"AW": new ( require("./weatherProviders/AccuWeather" ).default )(),
	"PW": new ( require("./weatherProviders/PirateWeather" ).default )(),
	"Apple": new ( require("./weatherProviders/Apple" ).default )(),
	"OWM": new ( require("./weatherProviders/OWM" ).default )(),
	"OpenMeteo": new ( require("./weatherProviders/OpenMeteo" ).default )(),
	"DWD": new ( require("./weatherProviders/DWD" ).default )(),
	"WU": new ( require("./weatherProviders/WUnderground" ).default )(),
  };

const PWS_WEATHER_PROVIDER: WeatherProvider = new ( require("./weatherProviders/" + ( process.env.PWS_WEATHER_PROVIDER || "WUnderground" ) ).default )();
const GEOCODER: Geocoder = new ( require("./geocoders/" + ( process.env.GEOCODER || "WUnderground" ) ).default )();

const filters = {
	gps: /^[-+]?([1-8]?\d(\.\d+)?|90(\.0+)?),\s*[-+]?(180(\.0+)?|((1[0-7]\d)|([1-9]?\d))(\.\d+)?)$/,
	pws: /^(?:pws|icao|zmw):/,
	url: /^https?:\/\/([\w\.-]+)(:\d+)?(\/.*)?$/,
	time: /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2})(\d{2})/,
	timezone: /^()()()()()()([+-])(\d{2})(\d{2})/
};

const ADJUSTMENT_METHOD: { [ key: number ] : AdjustmentMethod } = {
	0: ManualAdjustmentMethod,
	1: ZimmermanAdjustmentMethod,
	2: RainDelayAdjustmentMethod,
	3: EToAdjustmentMethod
};

const cache = new WateringScaleCache();
const LEGACY_FIRMWARE_SUPPORT = process.env.LEGACY_FIRMWARE_SUPPORT !== 'false';
const SIMPLIFIED_RESPONSE_FORMAT = process.env.SIMPLIFIED_RESPONSE_FORMAT !== 'false';

export function debugLog(...args: any[]) {
	if (process.env.DEBUG_WEATHER === "true") console.log(...args);
}

debugLog(`DEBUG: Backward compatibility - Legacy support: ${LEGACY_FIRMWARE_SUPPORT}, Simplified format: ${SIMPLIFIED_RESPONSE_FORMAT}`);

export function redactLogString( value: string ): string {
	return value
		.replace( /(https?:\/\/[^\s'")?]+)\?[^\s'")]+/g, "$1" )
		.replace( /((?:^|[,{]\s*)["']?(?:key|apiKey|apikey)["']?\s*:\s*["']?)([^"',}\]]*)(["']?)/gi, "$1[REDACTED]$3" )
		.replace( /((?:^|[,{]\s*)["']?wto["']?\s*:\s*["']?)([^"',}\]]*)(["']?)/gi, "$1[REDACTED]$3" )
		.replace( /(\b(?:key|apiKey|apikey|wto)=)[^&\s'")]+/gi, "$1[REDACTED]" );
}

export function redactLogValue( value: any ): any {
	if ( typeof value === "string" ) return redactLogString( value );
	if ( value instanceof Error ) {
		const redactedError = new Error( redactLogString( value.message ) );
		redactedError.name = value.name;
		redactedError.stack = value.stack ? redactLogString( value.stack ) : value.stack;
		return redactedError;
	}
	if ( Array.isArray( value ) ) return value.map( redactLogValue );
	if ( value && typeof value === "object" ) {
		const redacted: any = {};
		for ( const key of Object.keys( value ) ) {
			const lowerKey = key.toLowerCase();
			redacted[ key ] = ( lowerKey === "key" || lowerKey === "apikey" || lowerKey === "wto" )
				? "[REDACTED]"
				: redactLogValue( value[ key ] );
		}
		return redacted;
	}
	return value;
}

function isLegacyFirmwareRequest(req: express.Request): boolean {
	if (!LEGACY_FIRMWARE_SUPPORT) return false;
	const userAgent = req.headers['user-agent'] || '';
	const referer = req.headers['referer'] || '';
	const legacyIndicators = [
		userAgent.includes('OpenSprinkler'), userAgent.includes('ESP8266'), userAgent.includes('Arduino'),
		referer.includes('/su'), !req.headers['accept']?.includes('application/json'), req.query.format !== 'json'
	];
	const isLegacy = legacyIndicators.some(indicator => indicator);
	debugLog(`DEBUG: Legacy firmware detection - User-Agent: "${userAgent}", Referer: "${referer}", Accept: "${req.headers['accept']}", Query.format: "${req.query.format}", Detected as legacy: ${isLegacy}`);
	return isLegacy;
}

function convertToLegacyFormat(enhancedData: any, adjustmentMethod: AdjustmentMethod): any {
	if (!SIMPLIFIED_RESPONSE_FORMAT) {
		debugLog("DEBUG convertToLegacyFormat: SIMPLIFIED_RESPONSE_FORMAT is false, returning enhancedData.");
		return enhancedData;
	}
	debugLog("DEBUG convertToLegacyFormat: Converting enhanced response to legacy format. Input:", JSON.stringify(enhancedData));
	const legacyData: any = {
		scale: enhancedData.scale, rd: enhancedData.rd, tz: enhancedData.tz,
		sunrise: enhancedData.sunrise, sunset: enhancedData.sunset, eip: enhancedData.eip,
		errCode: enhancedData.errCode || 0
	};
	if (enhancedData.rawData) {
		const rawDataSource = enhancedData.rawData;
		legacyData.rawData = { wp: rawDataSource.wp || rawDataSource.weatherProvider || "local" };
		if (adjustmentMethod === EToAdjustmentMethod) {
			Object.assign(legacyData.rawData, {
				eto: rawDataSource.eto || rawDataSource.historical_eto, radiation: rawDataSource.radiation,
				minT: rawDataSource.minT, maxT: rawDataSource.maxT, minH: rawDataSource.minH,
				maxH: rawDataSource.maxH, wind: rawDataSource.wind, p: rawDataSource.p
			});
			if (rawDataSource.crop_coefficient) legacyData.rawData.kc = rawDataSource.crop_coefficient;
			if (rawDataSource.method && rawDataSource.method.includes('forecast')) {
				legacyData.rawData.forecast = 1;
				if (rawDataSource.forecast_precip_total) legacyData.rawData.fp = rawDataSource.forecast_precip_total;
			}
		} else if (adjustmentMethod === ZimmermanAdjustmentMethod) {
			Object.assign(legacyData.rawData, {
				h: rawDataSource.h, p: rawDataSource.p, t: rawDataSource.t, raining: rawDataSource.raining
			});
		}
	} else {
		debugLog("DEBUG convertToLegacyFormat: enhancedData.rawData is missing.");
	}
	debugLog("DEBUG convertToLegacyFormat: Legacy format conversion complete. Output:", JSON.stringify(legacyData));
	return legacyData;
}

// Helper function to generate a very basic, safe response object
function getSafeTestResponseObject(remoteIp: string = "1.2.3.4", requestTimezoneMinutes?: number): any {
    const testCoordinates: GeoCoordinates = [40.7128, -74.0060]; 
    const sunData = SunCalc.getTimes(new Date(), testCoordinates[0], testCoordinates[1]);
    
    let tzForOS: number;
    let sunriseMinutes: number;
    let sunsetMinutes: number;

    if (requestTimezoneMinutes !== undefined) {
        tzForOS = getTimezone(requestTimezoneMinutes, false); 
        const sunriseWithOffset = new Date(sunData.sunrise.getTime() + requestTimezoneMinutes * 60000);
        const sunsetWithOffset = new Date(sunData.sunset.getTime() + requestTimezoneMinutes * 60000);
        sunriseMinutes = sunriseWithOffset.getUTCHours() * 60 + sunriseWithOffset.getUTCMinutes();
        sunsetMinutes = sunsetWithOffset.getUTCHours() * 60 + sunsetWithOffset.getUTCMinutes();
    } else {
        const fallbackTimezoneOffsetMinutes = moment().tz(geoTZ(testCoordinates[0], testCoordinates[1])[0]).utcOffset();
        tzForOS = getTimezone(fallbackTimezoneOffsetMinutes, false);
        const sunriseWithFallbackOffset = new Date(sunData.sunrise.getTime() + fallbackTimezoneOffsetMinutes * 60000);
        const sunsetWithFallbackOffset = new Date(sunData.sunset.getTime() + fallbackTimezoneOffsetMinutes * 60000);
        sunriseMinutes = sunriseWithFallbackOffset.getUTCHours() * 60 + sunriseWithFallbackOffset.getUTCMinutes();
        sunsetMinutes = sunsetWithFallbackOffset.getUTCHours() * 60 + sunsetWithFallbackOffset.getUTCMinutes();
    }

    return {
        scale: 100,
        rd: 0,
        tz: tzForOS,
        sunrise: sunriseMinutes,
        sunset: sunsetMinutes,
        eip: ipToInt(remoteIp),
        rawData: { wp: "SafeTest", source: "HardcodedTestData" },
        errCode: 0
    };
}

export async function resolveCoordinates( location: string ): Promise< GeoCoordinates > {
	if ( !location ) throw new CodedError( ErrorCode.InvalidLocationFormat );
	if ( filters.pws.test( location ) ) throw new CodedError( ErrorCode.InvalidLocationFormat );
	if ( filters.gps.test( location ) ) {
		const split: string[] = location.split( "," );
		return [ parseFloat( split[ 0 ] ), parseFloat( split[ 1 ] ) ];
	}
	return GEOCODER.getLocation( location );
}

export async function httpJSONRequest(url: string, headers?: any, body?: any): Promise< any > {
	const data: string = await httpRequest(url, headers, body);
	return JSON.parse(data);
}

function getTimeDataForCoordinates( coordinates: GeoCoordinates ): TimeData {
	const timezoneOffsetMinutes = moment().tz( geoTZ( coordinates[ 0 ], coordinates[ 1 ] )[ 0 ] ).utcOffset();
	const sunData = SunCalc.getTimes( new Date(), coordinates[ 0 ], coordinates[ 1 ] );
	const sunrise = new Date(sunData.sunrise.getTime() + timezoneOffsetMinutes * 60000);
    const sunset = new Date(sunData.sunset.getTime() + timezoneOffsetMinutes * 60000);

	return {
		timezone:	timezoneOffsetMinutes,
		sunrise:	( sunrise.getUTCHours() * 60 + sunrise.getUTCMinutes() ),
		sunset:		( sunset.getUTCHours() * 60 + sunset.getUTCMinutes() )
	};
}

function checkWeatherRestriction( adjustmentValue: number, weather: BaseWateringData ): boolean {
	const californiaRestriction = ( adjustmentValue >> 7 ) & 1;
	if ( californiaRestriction && weather.precip > 0.1 ) return true;
	return false;
}

export const getWeatherData = async function( req: express.Request, res: express.Response ) {
	debugLog(`DEBUG getWeatherData: START - Path: ${req.path}, Query: ${JSON.stringify(redactLogValue(req.query))}`);
	
	const location: string = getParameter(req.query.loc);
	let adjustmentOptionsString: string	= getParameter(req.query.wto),
		adjustmentOptions: AdjustmentOptions;

	debugLog(`DEBUG getWeatherData: Raw location: "${location}", Raw adjustmentOptionsString: "${redactLogValue(adjustmentOptionsString)}"`);

	try {
		adjustmentOptionsString = decodeURIComponent( adjustmentOptionsString.replace( /\\x/g, "%" ) );
		adjustmentOptions = JSON.parse( "{" + adjustmentOptionsString + "}" );
		debugLog(`DEBUG getWeatherData: Parsed adjustmentOptions: ${JSON.stringify(redactLogValue(adjustmentOptions))}`);
	} catch ( err ) {
		console.error(`DEBUG getWeatherData: Failed to parse adjustmentOptions:`, redactLogValue(err));
		sendWateringError( res, new CodedError( ErrorCode.MalformedAdjustmentOptions ));
		return;
	}

	let coordinates: GeoCoordinates;
	try {
		coordinates = await resolveCoordinates( location );
	} catch (err: any) {
		console.error(`DEBUG getWeatherData: Failed to resolve coordinates:`, redactLogValue(err));
		res.send(`Error: Unable to resolve location (${redactLogValue(err.message || err)})`);
		return;
	}

	let pws: PWS | undefined = undefined;
	if ( adjustmentOptions.provider === "WU" && adjustmentOptions.pws && adjustmentOptions.key ) {
		const idMatch = adjustmentOptions.pws.match( /^[a-zA-Z\d]+$/ );
		const pwsId = idMatch ? idMatch[ 0 ] : undefined;
		const keyMatch = adjustmentOptions.key.match( /^[a-f\d]{32}$/ );
		const apiKey = keyMatch ? keyMatch[ 0 ] : undefined;
		if ( !pwsId ) { sendWateringError( res, new CodedError( ErrorCode.InvalidPwsId ) ); return; }
		if ( !apiKey ) { sendWateringError( res, new CodedError( ErrorCode.InvalidPwsApiKey ) ); return; }
		pws = { id: pwsId, apiKey: apiKey };
	} else if ( adjustmentOptions.key ){
		pws = {apiKey: adjustmentOptions.key};
	}

	let activeWeatherProvider: WeatherProvider;
	if (process.env.WEATHER_PROVIDER === "local") {
		activeWeatherProvider = new ( require("./weatherProviders/local" ).default )();
	} else {
		activeWeatherProvider = WEATHER_PROVIDERS[adjustmentOptions.provider] || WEATHER_PROVIDERS['Apple'];
	}
	debugLog(`DEBUG getWeatherData: Using provider: ${activeWeatherProvider.constructor.name}`);
	
	const timeData: TimeData = getTimeDataForCoordinates( coordinates );
	let weatherData: WeatherData;
	try {
		weatherData = await activeWeatherProvider.getWeatherData( coordinates, pws );
		debugLog(`DEBUG getWeatherData: ${activeWeatherProvider.constructor.name}.getWeatherData responded with: ${JSON.stringify(weatherData)}`);
	} catch ( err: any ) {
		console.error(`DEBUG getWeatherData: ${activeWeatherProvider.constructor.name}.getWeatherData failed:`, redactLogValue(err));
		res.send( "Error: " + redactLogValue(err.message || err) );
		return;
	}
	
	const response = { ...timeData, ...weatherData, location: coordinates };
	debugLog(`DEBUG getWeatherData: Final response for /weather endpoint: ${JSON.stringify(response)}`);
	res.json( response );
	debugLog(`DEBUG getWeatherData: END - Response sent.`);
};

export const getWateringData = async function( req: express.Request, res: express.Response ) {
	debugLog(`DEBUG getWateringData: START - Path: ${req.path}, Query: ${JSON.stringify(redactLogValue(req.query))}, Params: ${JSON.stringify(redactLogValue(req.params))}`);
	const isLegacyRequest = isLegacyFirmwareRequest(req);
	const adjustmentParam = parseInt(req.params[0], 10);

	if (isNaN(adjustmentParam)) {
		sendWateringError(res, new CodedError(ErrorCode.InvalidAdjustmentMethod), undefined, isLegacyRequest);
		return;
	}

	let adjustmentMethod: AdjustmentMethod	= ADJUSTMENT_METHOD[ adjustmentParam & ~( 1 << 7 ) ];
	let checkRestrictions: boolean = ( ( adjustmentParam >> 7 ) & 1 ) > 0;
	let adjustmentOptionsString: string = getParameter(req.query.wto);
	let location: string = getParameter(req.query.loc);
	let outputFormat: string = getParameter(req.query.format);
	let remoteAddress: string = getParameter(req.headers[ "x-forwarded-for" ]) || req.connection.remoteAddress || "";
	remoteAddress = remoteAddress.split( "," )[ 0 ].trim();
	if (remoteAddress === "::1" || remoteAddress === "127.0.0.1" || remoteAddress === "") remoteAddress = "1.2.3.4";

	let adjustmentOptions: AdjustmentOptions;

	if ( !adjustmentMethod ) {
		sendWateringError( res, new CodedError( ErrorCode.InvalidAdjustmentMethod ), undefined, isLegacyRequest);
		return;
	}

	try {
		adjustmentOptionsString = decodeURIComponent( adjustmentOptionsString.replace( /\\x/g, "%" ) );
		adjustmentOptions = JSON.parse( "{" + adjustmentOptionsString + "}" );
	} catch ( err ) {
		sendWateringError( res, new CodedError( ErrorCode.MalformedAdjustmentOptions ), adjustmentMethod !== ManualAdjustmentMethod, isLegacyRequest );
		return;
	}

	let coordinates: GeoCoordinates;
	try {
		coordinates = await resolveCoordinates( location );
	} catch ( err ) {
		sendWateringError( res, makeCodedError( err ), adjustmentMethod !== ManualAdjustmentMethod, isLegacyRequest );
		return;
	}

	let timeData: TimeData = getTimeDataForCoordinates( coordinates ); 

	let pws: PWS | undefined = undefined;
	if ( adjustmentOptions.provider === "WU" && adjustmentOptions.pws && adjustmentOptions.key ) {
		const idMatch = adjustmentOptions.pws.match( /^[a-zA-Z\d]+$/ );
		const pwsId = idMatch ? idMatch[ 0 ] : undefined;
		const keyMatch = adjustmentOptions.key.match( /^[a-f\d]{32}$/ );
		const apiKey = keyMatch ? keyMatch[ 0 ] : undefined;
		if ( !pwsId ) { sendWateringError( res, new CodedError( ErrorCode.InvalidPwsId ), adjustmentMethod !== ManualAdjustmentMethod, isLegacyRequest ); return; }
		if ( !apiKey ) { sendWateringError( res, new CodedError( ErrorCode.InvalidPwsApiKey ), adjustmentMethod !== ManualAdjustmentMethod, isLegacyRequest ); return; }
		pws = { id: pwsId, apiKey: apiKey };
	} else if ( adjustmentOptions.key ){
		pws = {apiKey: adjustmentOptions.key};
	}

	let weatherProvider: WeatherProvider;
	if( pws && pws.id ){
		weatherProvider = PWS_WEATHER_PROVIDER;
	} else {
		if (process.env.WEATHER_PROVIDER === "local") {
			weatherProvider = new ( require("./weatherProviders/local" ).default )();
		} else {
			weatherProvider = WEATHER_PROVIDERS[adjustmentOptions.provider] || WEATHER_PROVIDERS['Apple'];
		}
	}
	debugLog(`DEBUG getWateringData: Selected weather provider: ${weatherProvider.constructor.name}`);

	const initialDataStructure = {
		scale: undefined, rd: undefined,
		tz: getTimezone( timeData.timezone, false ),
		sunrise: timeData.sunrise, sunset: timeData.sunset,
		eip: ipToInt( remoteAddress ), rawData: undefined as any, errCode: 0
	};

	let cachedScale: CachedScale | undefined; 
	if ( weatherProvider.shouldCacheWateringScale() ) {
		cachedScale = cache.getWateringScale( adjustmentParam, coordinates, pws, adjustmentOptions );
	}

	let dataToSend = { ...initialDataStructure };

	if ( cachedScale ) {
        debugLog(`DEBUG getWateringData: Using cached watering scale: ${JSON.stringify(cachedScale)}`);
		dataToSend.scale = cachedScale.scale;
		dataToSend.rawData = cachedScale.rawData;
		dataToSend.rd = cachedScale.rainDelay;
	} else {
		let adjustmentMethodResponse: AdjustmentMethodResponse;
		try {
			adjustmentMethodResponse = await adjustmentMethod.calculateWateringScale(
				adjustmentOptions, coordinates, weatherProvider, pws
			);
			debugLog(`DEBUG getWateringData: ${adjustmentMethod.constructor.name}.calculateWateringScale response: ${JSON.stringify(adjustmentMethodResponse)}`);
		} catch ( err ) {
			sendWateringError( res, makeCodedError( err ), adjustmentMethod !== ManualAdjustmentMethod, isLegacyRequest, outputFormat === "json" );
			return;
		}
		dataToSend.scale = adjustmentMethodResponse.scale;
		dataToSend.rd = adjustmentMethodResponse.rainDelay;
		dataToSend.rawData = adjustmentMethodResponse.rawData;

		if ( checkRestrictions ) {
			let wateringDataForRestriction: BaseWateringData | undefined = adjustmentMethodResponse.wateringData; 
			if ( !wateringDataForRestriction ) {
				try {
                    debugLog(`DEBUG getWateringData: Fetching watering data for restriction check from ${weatherProvider.constructor.name}`);
					wateringDataForRestriction = await weatherProvider.getWateringData( coordinates, pws );
                    debugLog(`DEBUG getWateringData: Watering data for restriction check: ${JSON.stringify(wateringDataForRestriction)}`);
				} catch ( err ) {
					sendWateringError( res, makeCodedError( err ), adjustmentMethod !== ManualAdjustmentMethod, isLegacyRequest, outputFormat === "json" );
					return;
				}
			}
			if ( wateringDataForRestriction && checkWeatherRestriction( adjustmentParam, wateringDataForRestriction ) ) {
                debugLog(`DEBUG getWateringData: Weather restriction met. Setting scale to 0.`);
				dataToSend.scale = 0;
			}
		}
		if ( weatherProvider.shouldCacheWateringScale() ) {
            const cacheEntry = { scale: dataToSend.scale, rawData: dataToSend.rawData, rainDelay: dataToSend.rd };
            debugLog(`DEBUG getWateringData: Caching watering scale: ${JSON.stringify(cacheEntry)}`);
			cache.storeWateringScale( adjustmentParam, coordinates, pws, adjustmentOptions, cacheEntry );
		}
	}
	
    debugLog(`DEBUG getWateringData: Data before legacy conversion (dataToSend): ${JSON.stringify(dataToSend)}`);
	let responseData = dataToSend;
	if ( isLegacyRequest ) {
        debugLog(`DEBUG getWateringData: Applying legacy format conversion because isLegacyRequest is true.`);
		responseData = convertToLegacyFormat( dataToSend, adjustmentMethod );
	} else {
        debugLog(`DEBUG getWateringData: Not applying legacy format conversion because isLegacyRequest is false.`);
    }

	debugLog(`DEBUG getWateringData: Final responseData to be sent: ${JSON.stringify(responseData)}`);
	debugLog(`DEBUG getWateringData: Sending response - Scale: ${responseData.scale}, Method: ${adjustmentMethod?.constructor?.name || "N/A"}, Legacy: ${isLegacyRequest}, OutputFormat: ${outputFormat === "json" ? "JSON" : "QueryString"}`);
	sendWateringData( res, responseData, outputFormat === "json" );
	debugLog(`DEBUG getWateringData: END - Response sent.`);
};

function sendWateringError( res: express.Response, error: CodedError, resetScale: boolean = true, isLegacyRequest: boolean = false, useJson: boolean = false ) {
	console.error(`DEBUG sendWateringError: Error Code: ${error.errCode}, Message: ${redactLogValue(error.message)}, ResetScale: ${resetScale}, IsLegacy: ${isLegacyRequest}, UseJSON: ${useJson}`);
	if ( error.errCode === ErrorCode.UnexpectedError ) console.error( `An unexpected error occurred:`, redactLogValue(error) );

	let errorData: any = { errCode: error.errCode };
    if (resetScale) errorData.scale = 100;
	
	if ( isLegacyRequest && SIMPLIFIED_RESPONSE_FORMAT ) {
		const legacyErrorData: any = { scale: resetScale ? 100 : undefined, errCode: error.errCode };
		debugLog(`DEBUG sendWateringError: Applied legacy format to error response: ${JSON.stringify(legacyErrorData)}`);
        sendWateringData( res, legacyErrorData, useJson );
        return;
	}
	sendWateringData( res, errorData, useJson );
}

function sendWateringData( res: express.Response, data: object, useJson: boolean = false ) {
	if ( useJson ) {
		debugLog(`DEBUG sendWateringData: Sending JSON response: ${JSON.stringify(data)}`);
		res.json( data );
	} else {
		let formatted = "";
		for ( const key in data ) {
			if ( !data.hasOwnProperty( key ) ) continue;
			let value = (data as any)[ key ];
			value = encodeLegacyWateringValue( value );
			if ( typeof value === "undefined" ) continue;
			formatted += `&${ key }=${ value }`;
		}
		debugLog(`DEBUG sendWateringData: Sending QueryString response: "${formatted}"`);
		res.send( formatted );
	}
}

/**
 * Encodes one value for the fixed OpenSprinkler legacy firmware wire format.
 * The firmware decodes this custom scheme: space -> "+", newline -> "\n", and
 * "&" -> "AMPERSAND". Do not use URLSearchParams or encodeURIComponent here;
 * standard URL encoding changes the on-the-wire bytes and breaks legacy parsers.
 */
function encodeLegacyWateringValue( value: any ): string | undefined {
	switch ( typeof value ) {
		case "undefined":
			return undefined;
		case "object": {
			const jsonValue = JSON.stringify( value );
			return String( jsonValue ).replace( / /g, "+" ).replace( /\n/g, "\\n" ).replace( /&/g, "AMPERSAND" );
		}
		case "string":
			return String( value ).replace( / /g, "+" ).replace( /\n/g, "\\n" ).replace( /&/g, "AMPERSAND" );
		default:
			return String( value );
	}
}

async function httpRequest( url: string, headers?: any, body?: any ): Promise< string > {
	return new Promise< string >( ( resolve, reject ) => {
		const urlMatch = url.match( filters.url );
		if (!urlMatch) return reject(new Error(`Invalid URL format: ${redactLogString(url)}`));
		const configuredTimeoutMs = Number(process.env.HTTP_REQUEST_TIMEOUT_MS);
		const requestTimeoutMs = Number.isSafeInteger(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 10000;
		
		const isHttps = url.startsWith("https");
		const options: https.RequestOptions = {
			hostname: urlMatch[1],
			port: parseInt(urlMatch[2]?.substring(1)) || (isHttps ? 443 : 80),
			path: urlMatch[3],
			method: body ? 'POST' : 'GET',
			headers: headers || {}
		};
		if (body) {
			options.headers!['Content-Type'] = 'application/json';
			options.headers!['Content-Length'] = Buffer.byteLength(body);
		}

		const req = (isHttps ? https : http).request(options, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				return reject(new Error(`Received ${res.statusCode} status code for URL '${redactLogString(url)}'.`));
			}
			let responseData = "";
			res.setEncoding('utf8');
			res.on("data", (chunk) => { responseData += chunk; });
			res.on("end", () => { resolve(responseData); });
		});
		req.setTimeout(requestTimeoutMs, () => {
			req.destroy(new Error(`HTTP request timed out after ${requestTimeoutMs} ms for URL '${redactLogString(url)}'.`));
		});
		req.on("error", (err) => { reject(err); });
		if (body) req.write(body);
		req.end();
	});
}

export function validateValues( keys: string[], obj: any ): boolean {
   if ( !obj ) return false;
   for ( const key of keys ) { 
   	if ( !obj.hasOwnProperty( key ) || typeof obj[key] !== "number" || isNaN(obj[key]) || obj[key] === null || obj[key] === -999 ) {
   		return false;
   	}
   }
   return true;
}

function getTimezone( time: number | string, useMinutes: boolean = false ): number {
   let hour: number;
   let minute: number;

   if ( typeof time === "number" ) {
       if (useMinutes) {
           return time;
       }
       hour = Math.floor( time / 60 );
       minute = Math.abs(time % 60);
   } else {
       const splitTime = time.match( filters.time ) || time.match( filters.timezone );
       if (!splitTime || !splitTime[7] || !splitTime[8] || !splitTime[9]) {
           console.error("getTimezone: Invalid time string format or missing parts", time);
           return 0;
       }
       const signChar = splitTime[7];
       const hourStr = splitTime[8];
       const minuteStr = splitTime[9];
       hour = parseInt(hourStr);
       minute = parseInt(minuteStr);
       if (signChar === '-') {
           hour = -hour;
       }
       if (useMinutes) {
           return (hour * 60) + (signChar === '-' ? -minute : minute);
       }
   }
   const osMinutePart = (minute / 15 >> 0) / 4;
   hour = hour + ( hour >= 0 ? osMinutePart : -osMinutePart );
   return ( ( hour + 12 ) * 4 ) >> 0;
}

function ipToInt( ip: string ): number {
   const split = ip.split( "." );
   if (split.length !== 4 || split.some(part => isNaN(parseInt(part)) || parseInt(part) < 0 || parseInt(part) > 255)) {
	   console.error("ipToInt: Invalid IP address format", ip);
	   return 0;
   }
   return ((((+split[0]) * 256 + (+split[1])) * 256 + (+split[2])) * 256) + (+split[3]);
}

export function getParameter(param: string | ParsedQs | (string | ParsedQs)[] | undefined): string {
    if (param === undefined) {
        return "";
    }
    if (typeof param === 'string') {
        return param;
    }
    if (Array.isArray(param)) {
        if (param.length === 0) {
            return "";
        }
        const firstEl = param[0];
        if (typeof firstEl === 'string') {
            return firstEl;
        }
        if (typeof firstEl === 'object' && firstEl !== null) {
            const keys = Object.keys(firstEl);
            if (keys.length > 0) {
                const valOfFirstKeyInElement = firstEl[keys[0]];
                if (typeof valOfFirstKeyInElement === 'string') {
                    return valOfFirstKeyInElement;
                }
                if (Array.isArray(valOfFirstKeyInElement) && valOfFirstKeyInElement.length > 0 && typeof valOfFirstKeyInElement[0] === 'string') {
                    return valOfFirstKeyInElement[0];
                }
            }
        }
        return "";
    }
    if (typeof param === 'object' && param !== null) {
        const keys = Object.keys(param);
        if (keys.length > 0) {
            const valOfFirstKey = param[keys[0]];
            if (typeof valOfFirstKey === 'string') {
                return valOfFirstKey;
            }
            if (Array.isArray(valOfFirstKey) && valOfFirstKey.length > 0 && typeof valOfFirstKey[0] === 'string') {
                return valOfFirstKey[0];
            }
        }
    }
    return "";
}

export function keyToUse( defaultKey: string, pws: PWS | undefined ): string {
   if(pws && pws.apiKey){
   	return pws.apiKey;
   }else if(defaultKey){
   	return defaultKey;
   }else{
   	throw new CodedError( ErrorCode.NoAPIKeyProvided );
   }
}
