import * as express from "express";
import { GeoCoordinates, PWS } from "../../types";
import { AdjustmentOptions } from "../adjustmentMethods/AdjustmentMethod";
import { getBudgetState } from "../adjustmentMethods/WaterBudgetAdjustmentMethod";
import {
	buildPwsFromParams, computeWateringDecision, getParameter,
	redactLogString, resolveCoordinates, resolveWeatherProvider, WateringDecision
} from "../weather";
import { CodedError, ErrorCode, makeCodedError } from "../../errors";

/** Map a CodedError to an HTTP status + clean error code for the /v1 API. */
function v1Status( errCode: ErrorCode ): { status: number; code: string } {
	switch ( errCode ) {
		case ErrorCode.UnsupportedAdjustmentMethod:
			return { status: 422, code: "unsupported_method" };
		case ErrorCode.InvalidLocationFormat:
		case ErrorCode.NoLocationFound:
		case ErrorCode.MalformedAdjustmentOptions:
		case ErrorCode.MissingAdjustmentOption:
		case ErrorCode.InvalidAdjustmentMethod:
		case ErrorCode.InvalidPwsId:
		case ErrorCode.InvalidPwsApiKey:
			return { status: 400, code: "bad_request" };
		default:
			return { status: 502, code: "upstream_error" };
	}
}

export function sendV1Error( res: express.Response, err: any ): void {
	const coded = makeCodedError( err );
	const { status, code } = v1Status( coded.errCode );
	res.status( status ).json( { error: { code, message: redactLogString( coded.message || code ) } } );
}

function badRequest( res: express.Response, message: string ): void {
	res.status( 400 ).json( { error: { code: "bad_request", message } } );
}

function resolvePwsOrThrow( adjustmentOptions: AdjustmentOptions ): PWS | undefined {
	return buildPwsFromParams( adjustmentOptions );
}

function shapeWateringResponse( d: WateringDecision ): any {
	const raw = d.rawData || {};
	return {
		location: d.coordinates,
		method: d.methodName,
		methodName: d.methodName,
		methodId: d.methodId,
		scale: d.scale,
		rainDelay: d.rainDelay,
		skip: d.skip,
		skipReason: d.skipReason !== undefined ? d.skipReason : null,
		pwsBypassed: d.pwsBypassed,
		weatherProvider: d.weatherProvider,
		reason: raw.reason !== undefined ? raw.reason : null,
		raw: d.rawData
	};
}

function shapeWeatherResponse( coordinates: GeoCoordinates, weather: any ): any {
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

const BUDGET_HISTORY_CAP = 90;
const BUDGET_HISTORY_DEFAULT = 30;

function shapeBudgetResponse( coordinates: GeoCoordinates, state: any, limit: number ): any {
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

export const v1Watering = async function ( req: express.Request, res: express.Response ): Promise< void > {
	const loc = getParameter( req.query.loc );
	if ( !loc ) { badRequest( res, "Missing required 'loc' parameter." ); return; }

	const methodRaw = getParameter( req.query.method );
	const methodId = parseInt( methodRaw, 10 );
	if ( methodRaw === "" || isNaN( methodId ) || methodId < 0 || methodId > 4 ) {
		badRequest( res, "'method' must be an integer 0-4." ); return;
	}
	const restrict = [ "1", "true", "yes", "on" ].indexOf( String( getParameter( req.query.restrict ) ).toLowerCase() ) !== -1;
	const adjustmentParam = methodId | ( restrict ? ( 1 << 7 ) : 0 );

	const adjustmentOptions: AdjustmentOptions = {
		provider: getParameter( req.query.provider ) || undefined,
		pws: getParameter( req.query.pws ) || undefined,
		key: getParameter( req.query.key ) || undefined
	};

	try {
		const coordinates: GeoCoordinates = await resolveCoordinates( loc );
		const pws = resolvePwsOrThrow( adjustmentOptions );
		const decision = await computeWateringDecision( { coordinates, adjustmentParam, adjustmentOptions, pws } );
		res.json( shapeWateringResponse( decision ) );
	} catch ( err ) {
		sendV1Error( res, err );
	}
};

export const v1Weather = async function ( req: express.Request, res: express.Response ): Promise< void > {
	const loc = getParameter( req.query.loc );
	if ( !loc ) { badRequest( res, "Missing required 'loc' parameter." ); return; }
	const adjustmentOptions: AdjustmentOptions = {
		provider: getParameter( req.query.provider ) || undefined,
		pws: getParameter( req.query.pws ) || undefined,
		key: getParameter( req.query.key ) || undefined
	};
	try {
		const coordinates: GeoCoordinates = await resolveCoordinates( loc );
		const pws = resolvePwsOrThrow( adjustmentOptions );
		const provider = resolveWeatherProvider( adjustmentOptions, pws );
		const weather = await provider.getWeatherData( coordinates, pws );
		res.json( shapeWeatherResponse( coordinates, weather ) );
	} catch ( err ) {
		sendV1Error( res, err );
	}
};

export const v1Budget = async function ( req: express.Request, res: express.Response ): Promise< void > {
	const loc = getParameter( req.query.loc );
	if ( !loc ) { badRequest( res, "Missing required 'loc' parameter." ); return; }
	let limit = parseInt( getParameter( req.query.limit ), 10 );
	if ( isNaN( limit ) || limit <= 0 ) limit = BUDGET_HISTORY_DEFAULT;
	if ( limit > BUDGET_HISTORY_CAP ) limit = BUDGET_HISTORY_CAP;
	try {
		const coordinates: GeoCoordinates = await resolveCoordinates( loc );
		const state = await getBudgetState( coordinates );
		if ( !state ) {
			res.status( 404 ).json( { error: { code: "no_budget_state", message: "No Water-Budget state for this location yet." } } );
			return;
		}
		res.json( shapeBudgetResponse( coordinates, state, limit ) );
	} catch ( err ) {
		sendV1Error( res, err );
	}
};

const router = express.Router();
router.get( "/watering", v1Watering );
router.get( "/weather", v1Weather );
router.get( "/budget", v1Budget );
export default router;
