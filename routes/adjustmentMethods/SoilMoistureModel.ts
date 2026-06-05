export interface BudgetParams {
	/** Crop coefficient applied to reference ETo to get demand. */
	kc: number;
	/** Upper clamp for the returned scale (e.g. 200). */
	maxScale: number;
	/** Fraction of precip counted as effective rain (0..1). */
	runoffFactor: number;
	/** Max days of rain memory: rainBankCap = rainBankCapDays * referenceETc. */
	rainBankCapDays: number;
	/** A gap (in days) longer than this resets the rain memory. */
	gapResetDays: number;
}

export interface DecisionRecord {
	date: string;
	scale: number;
	eto: number;
	etc: number;
	effectiveRain: number;
	unmetDemand: number;
	rainBankBefore: number;
	rainBankAfter: number;
	referenceEtc: number;
	resolvedLocation?: string;
	reason: string;
}

export interface BudgetState {
	rainBank: number;
	lastUpdated: string;
	lastScale: number;
	history: DecisionRecord[];
}

export interface StepInput {
	today: string;
	eto: number;
	precip: number;
	referenceEto: number;
	resolvedLocation?: string;
	params: BudgetParams;
}

export interface StepResult {
	state: BudgetState;
	scale: number;
	reason: string;
}

export const HISTORY_CAP = 90;

function clamp( v: number, lo: number, hi: number ): number {
	return Math.max( lo, Math.min( hi, v ) );
}

function round2( v: number ): number {
	return Math.round( v * 100 ) / 100;
}

/** Coerce non-finite numbers (NaN / Infinity) to 0 so bad inputs never poison the budget. */
function fin( v: number ): number {
	return Number.isFinite( v ) ? v : 0;
}

/** Whole days between two YYYY-MM-DD strings (b - a). UTC-based and pure. */
export function daysBetween( a: string, b: string ): number {
	const ms = Date.parse( a + "T00:00:00Z" );
	const ms2 = Date.parse( b + "T00:00:00Z" );
	return Math.round( ( ms2 - ms ) / 86400000 );
}

function buildReason( p: {
	scale: number; etc: number; referenceEtc: number; effectiveRain: number;
	rainBankAfter: number; gapReset: boolean; coldStart: boolean; resolvedLocation?: string;
} ): string {
	const loc = p.resolvedLocation ? ` for ${ p.resolvedLocation }` : "";
	const prefix = `Scale ${ p.scale }%: `;
	if ( p.gapReset ) return `${ prefix }resumed after a gap; rain memory reset${ loc }.`;
	if ( p.scale === 0 && p.rainBankAfter > 0 ) return `${ prefix }~${ round2( p.rainBankAfter ) }" of stored rain still covers demand${ loc }.`;
	if ( p.effectiveRain > 0 && p.scale < 100 ) return `${ prefix }recent rain (${ round2( p.effectiveRain ) }") reduces watering need${ loc }.`;
	if ( p.etc > p.referenceEtc ) return `${ prefix }above-normal evaporation (ETc ${ round2( p.etc ) }" vs normal ${ round2( p.referenceEtc ) }")${ loc }.`;
	if ( p.coldStart ) return `${ prefix }first run; watering at a normal level for current conditions${ loc }.`;
	return `${ prefix }dry conditions; watering at ${ p.scale }% of normal${ loc }.`;
}

/**
 * Advance the open-loop rain-bank water budget by one day. Pure: no I/O, no clock.
 */
export function step( prev: BudgetState | undefined, input: StepInput ): StepResult {
	const { today, eto, precip, referenceEto, resolvedLocation, params } = input;
	// Clamp ET to >= 0 AND coerce non-finite values to 0: calculateETo has no lower
	// bound (a small negative would fake rain memory), and missing weather fields can
	// yield NaN — note Math.max(0, NaN) === NaN, which would otherwise persist a
	// corrupted (NaN) rain bank and poison this location forever.
	const etc = Math.max( 0, fin( eto ) ) * params.kc;
	const referenceEtc = Math.max( 0, fin( referenceEto ) ) * params.kc;
	const effectiveRain = Math.max( 0, fin( precip ) ) * params.runoffFactor;

	// Same-day re-poll: return the stored result unchanged (idempotent).
	if ( prev && prev.lastUpdated === today ) {
		const last = prev.history[ prev.history.length - 1 ];
		return { state: prev, scale: prev.lastScale, reason: last ? last.reason : "" };
	}

	// Gap reset: a long outage means we missed days of weather; drop stored memory.
	let rainBankBefore = prev ? fin( prev.rainBank ) : 0;
	let gapReset = false;
	if ( prev ) {
		const gap = daysBetween( prev.lastUpdated, today );
		if ( gap > params.gapResetDays ) { rainBankBefore = 0; gapReset = true; }
	}

	const available = rainBankBefore + effectiveRain;
	const metByRain = Math.min( etc, available );
	const unmetDemand = Math.max( 0, etc - metByRain );
	const rainBankCap = params.rainBankCapDays * referenceEtc;
	const rainBankAfter = clamp( available - metByRain, 0, rainBankCap );
	const scale = referenceEtc > 0
		? clamp( Math.round( 100 * unmetDemand / referenceEtc ), 0, params.maxScale )
		: 0;

	const reason = buildReason( {
		scale, etc, referenceEtc, effectiveRain, rainBankAfter,
		gapReset, coldStart: !prev, resolvedLocation
	} );

	const record: DecisionRecord = {
		date: today, scale,
		eto: round2( eto ), etc: round2( etc ), effectiveRain: round2( effectiveRain ),
		unmetDemand: round2( unmetDemand ), rainBankBefore: round2( rainBankBefore ),
		rainBankAfter: round2( rainBankAfter ), referenceEtc: round2( referenceEtc ),
		resolvedLocation, reason
	};
	const history = ( prev ? prev.history : [] ).concat( record ).slice( -HISTORY_CAP );

	return {
		state: { rainBank: rainBankAfter, lastUpdated: today, lastScale: scale, history },
		scale, reason
	};
}
