import * as moment from "moment-timezone";
import * as geoTZ from "geo-tz";
import { AdjustmentMethod, AdjustmentMethodResponse, AdjustmentOptions } from "./AdjustmentMethod";
import { GeoCoordinates, PWS } from "../../types";
import { WeatherProvider } from "../weatherProviders/WeatherProvider";
import { calculateETo, EToData, EToScalingAdjustmentOptions } from "./EToAdjustmentMethod";
import { getBaselineDailyETo } from "../baselineETo";
import { BudgetParams, BudgetState, step } from "./SoilMoistureModel";
import { FileStateStore, StateStore } from "../state/StateStore";
import { makeCodedError } from "../../errors";

const DEFAULT_STATE_FILE = __dirname + "/../../waterBudgetState.json";
const store: StateStore = new FileStateStore( process.env.BUDGET_STATE_FILE || DEFAULT_STATE_FILE );

function envNum( name: string, fallback: number ): number {
	const v = Number( process.env[ name ] );
	return Number.isFinite( v ) && v > 0 ? v : fallback;
}

function optNum( value: any, fallback: number ): number {
	const v = Number( value );
	return Number.isFinite( v ) && v > 0 ? v : fallback;
}

// Config is ENV-ONLY in v1. Per-request kc/mx overrides were considered but
// dropped: state advances once per calendar day (same-day re-polls are idempotent),
// so a same-day kc/mx change could not take effect and would mislead. Per-request
// tuning is a deliberate future enhancement.
function resolveParams(): BudgetParams {
	return {
		kc: envNum( "BUDGET_KC", 0.9 ),
		maxScale: envNum( "BUDGET_MAX_SCALE", 200 ),
		runoffFactor: envNum( "BUDGET_RUNOFF", 1.0 ),
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

function round( v: number, dp: number ): number {
	const f = Math.pow( 10, dp );
	return Math.round( v * f ) / f;
}

async function calculateWaterBudgetScale(
	adjustmentOptions: AdjustmentOptions,
	coordinates: GeoCoordinates,
	weatherProvider: WeatherProvider,
	pws?: PWS
): Promise< AdjustmentMethodResponse > {
	const params = resolveParams();
	const elevation = optNum( ( adjustmentOptions as EToScalingAdjustmentOptions ).elevation, envNum( "BUDGET_ELEVATION", 600 ) );
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

	let referenceEto: number;
	try {
		referenceEto = await getBaselineDailyETo( coordinates );
	} catch ( err ) {
		referenceEto = envNum( "BUDGET_DEFAULT_REF_ETO", 0.15 );
	}

	const prev = await safeGet( key );
	const { state, scale, reason } = step( prev, {
		today, eto, precip: etoData.precip, referenceEto, resolvedLocation: undefined, params
	} );
	await safeSet( key, state );

	return {
		scale,
		rawData: {
			wp: etoData.weatherProvider,
			scale,
			eto: round( eto, 3 ),
			etc: round( eto * params.kc, 3 ),
			p: round( etoData.precip, 2 ),
			bank: round( state.rainBank, 2 ),
			reason
		},
		wateringData: etoData
	};
}

const WaterBudgetAdjustmentMethod: AdjustmentMethod = {
	calculateWateringScale: calculateWaterBudgetScale
};
export default WaterBudgetAdjustmentMethod;
