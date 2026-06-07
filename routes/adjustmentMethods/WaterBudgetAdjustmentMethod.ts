import * as moment from "moment-timezone";
import * as geoTZ from "geo-tz";
import { AdjustmentMethod, AdjustmentMethodResponse, AdjustmentOptions } from "./AdjustmentMethod";
import { GeoCoordinates, PWS } from "../../types";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import { calculateETo, EToData, EToScalingAdjustmentOptions } from "./EToAdjustmentMethod";
import { getBaselineDailyETo } from "../baselineETo";
import { BudgetParams, BudgetState, DecisionRecord, step } from "./SoilMoistureModel";
import { clampKc, resolveCropCoefficient } from "./PlantCoefficients";
import { FileStateStore, StateStore } from "../state/StateStore";
import { CodedError, ErrorCode, makeCodedError } from "../../errors";

const DEFAULT_STATE_FILE = __dirname + "/../../waterBudgetState.json";
const store: StateStore = new FileStateStore( process.env.BUDGET_STATE_FILE || DEFAULT_STATE_FILE );

function envNum( name: string, fallback: number ): number {
	const v = Number( process.env[ name ] );
	return Number.isFinite( v ) && v > 0 ? v : fallback;
}

function envNonNegativeNum( name: string, fallback: number ): number {
	const v = Number( process.env[ name ] );
	return Number.isFinite( v ) && v >= 0 ? v : fallback;
}

function optNum( value: any, fallback: number ): number {
	const v = Number( value );
	return Number.isFinite( v ) && v > 0 ? v : fallback;
}

function resolveParams(): BudgetParams {
	const baseKc = envNum( "BUDGET_KC", 0.9 );
	return {
		kc: baseKc,
		referenceKc: baseKc,
		maxScale: envNum( "BUDGET_MAX_SCALE", 200 ),
		runoffFactor: Math.min( 1, envNonNegativeNum( "BUDGET_RUNOFF", 1.0 ) ),
		rainBankCapDays: envNum( "BUDGET_RAINBANK_CAP_DAYS", 14 ),
		gapResetDays: envNum( "BUDGET_GAP_RESET", 2 )
	};
}

/** Local calendar date (YYYY-MM-DD) for the data window, in the site's timezone. */
function localDateString( coordinates: GeoCoordinates, periodStartTime: number ): string {
	return moment.unix( periodStartTime ).tz( geoTZ( coordinates[ 0 ], coordinates[ 1 ] )[ 0 ] ).format( "YYYY-MM-DD" );
}

function stateKey( coordinates: GeoCoordinates ): string {
	return `${ coordinates[ 0 ].toFixed( 4 ) },${ coordinates[ 1 ].toFixed( 4 ) }`;
}

async function safeGet( key: string ): Promise< BudgetState | undefined > {
	try { return await store.get( key ); }
	catch ( err ) { console.error( "WaterBudget: state read failed; treating as cold start.", err ); return undefined; }
}

async function safeSet( key: string, state: BudgetState ): Promise< void > {
	try { await store.set( key, state ); }
	catch ( err ) { console.error( "WaterBudget: state write failed; continuing.", err ); }
}

/** Read-only accessor for a location's persisted Water-Budget state (for the /v1 API). */
export async function getBudgetState( coordinates: GeoCoordinates ): Promise< BudgetState | undefined > {
	return safeGet( stateKey( coordinates ) );
}

function round( v: number, dp: number ): number {
	const f = Math.pow( 10, dp );
	return Math.round( v * f ) / f;
}

function buildRawDataFromDecision( weatherProvider: string, scale: number, record: DecisionRecord ) {
	const raw: any = {
		wp: weatherProvider,
		scale,
		eto: record.eto,
		etc: record.etc,
		p: record.effectiveRain,
		bank: round( record.rainBankAfter, 2 ),
		reason: record.reason
	};
	if ( record.kcSource && record.kcSource !== "budget" ) {
		raw.kc = record.demandKc;
		raw.kcSource = record.kcSource;
	}
	return raw;
}

function withLateBudgetKcFlag( rawData: any, requestedKc: number, appliedKc: number | undefined ): any {
	return {
		...rawData,
		budgetKcApplied: false,
		budgetKcRequested: round( requestedKc, 2 ),
		budgetKcLockedForToday: true,
		reason: `${ rawData.reason || `Scale ${ rawData.scale }%: cached WaterBudget result.` } Budget Kc override locked for today; applied Kc ${ appliedKc === undefined ? "unknown" : round( appliedKc, 2 ) } remains in effect until the next advancing poll.`
	};
}

async function calculateWaterBudgetScale(
	adjustmentOptions: AdjustmentOptions,
	coordinates: GeoCoordinates,
	weatherProvider: WeatherProvider,
	pws?: PWS
): Promise< AdjustmentMethodResponse > {
	const params = resolveParams();
	const elevation = optNum( ( adjustmentOptions as EToScalingAdjustmentOptions ).elevation, envNum( "BUDGET_ELEVATION", 600 ) );
	const overrideKc = clampKc( adjustmentOptions.budgetKc );
	const key = stateKey( coordinates );

	let etoData: EToData;
	try {
		etoData = await weatherProvider.getEToData( coordinates, pws );
	} catch ( err ) {
		const prev = await safeGet( key );
		if ( prev ) {
			return {
				scale: prev.lastScale,
				rawData: { wp: "WaterBudget", scale: prev.lastScale, reason: `Scale ${ prev.lastScale }%: weather unavailable, holding last value (stale).` },
				wateringData: { weatherProvider: "WaterBudget" as any, precip: 0 }
			};
		}
		throw makeCodedError( err );
	}

	const eto = calculateETo( etoData, elevation, coordinates );
	const today = localDateString( coordinates, etoData.periodStartTime );
	const prev = await safeGet( key );

	// Fail open on incomplete weather: if ET or precip is non-finite (missing fields or
	// junk from the provider), do NOT run the model — it would persist a corrupted (NaN)
	// rain bank. Hold the last scale if we have prior state, else surface a coded error.
	if ( !Number.isFinite( eto ) || !Number.isFinite( etoData.precip ) ) {
		if ( prev ) {
			return {
				scale: prev.lastScale,
				rawData: { wp: "WaterBudget", scale: prev.lastScale, reason: `Scale ${ prev.lastScale }%: incomplete weather data, holding last value (stale).` },
				wateringData: etoData
			};
		}
		throw new CodedError( ErrorCode.MissingWeatherField );
	}

	if ( prev && prev.lastUpdated === today ) {
		const last = prev.history[ prev.history.length - 1 ];
		if ( last ) {
			const rawData = buildRawDataFromDecision( etoData.weatherProvider, prev.lastScale, last );
			const lateBudgetKc = overrideKc !== undefined
				&& ( last.demandKc === undefined || Math.abs( overrideKc - last.demandKc ) > 0.005 );
			return {
				scale: prev.lastScale,
				rawData: lateBudgetKc ? withLateBudgetKcFlag( rawData, overrideKc, last.demandKc ) : rawData,
				wateringData: etoData
			};
		}
	}

	let referenceEto: number;
	try {
		referenceEto = await getBaselineDailyETo( coordinates );
	} catch ( err ) {
		referenceEto = envNum( "BUDGET_DEFAULT_REF_ETO", 0.15 );
	}

	const referenceKc = params.referenceKc === undefined ? params.kc : params.referenceKc;
	const dayOfYear = moment.unix( etoData.periodStartTime )
		.tz( geoTZ( coordinates[ 0 ], coordinates[ 1 ] )[ 0 ] ).dayOfYear();
	const kcEnv = {
		PLANT_TYPE: process.env.BUDGET_PLANT_TYPE,
		CUSTOM_CROP_COEFFICIENT: process.env.BUDGET_CUSTOM_CROP_COEFFICIENT
	};
	const resolvedKc = resolveCropCoefficient(
		{}, dayOfYear,
		() => ( { kc: referenceKc, factors: { source: "budget" } } ),
		kcEnv
	);
	let demandKc = resolvedKc.kc;
	if ( !Number.isFinite( demandKc ) || demandKc <= 0 ) demandKc = referenceKc;
	let kcSource: string | undefined = resolvedKc.factors && resolvedKc.factors.source;
	if ( overrideKc !== undefined ) {
		demandKc = overrideKc;
		kcSource = "override-budget";
	}

	const { state, scale, reason } = step( prev, {
		today, eto, precip: etoData.precip, referenceEto, resolvedLocation: undefined,
		kcSource, params: { ...params, kc: demandKc }
	} );
	await safeSet( key, state );
	const last = state.history[ state.history.length - 1 ];

	return {
		scale,
		rawData: last
			? {
				...buildRawDataFromDecision( etoData.weatherProvider, scale, last ),
				...( kcSource === "override-budget" ? { budgetKcApplied: true } : {} )
			}
			: ( () => {
				const raw: any = {
					wp: etoData.weatherProvider,
					scale,
					eto: round( eto, 3 ),
					etc: round( eto * demandKc, 3 ),
					p: round( etoData.precip * params.runoffFactor, 2 ),
					bank: round( state.rainBank, 2 ),
					reason
				};
				if ( kcSource && kcSource !== "budget" ) { raw.kc = round( demandKc, 2 ); raw.kcSource = kcSource; }
				if ( kcSource === "override-budget" ) raw.budgetKcApplied = true;
				return raw;
			} )(),
		wateringData: etoData
	};
}

const WaterBudgetAdjustmentMethod: AdjustmentMethod = {
	calculateWateringScale: calculateWaterBudgetScale
};
export default WaterBudgetAdjustmentMethod;
