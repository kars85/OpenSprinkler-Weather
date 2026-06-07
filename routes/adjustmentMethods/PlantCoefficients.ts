export type PlantType =
	| "trees" | "shrubs" | "groundcover" | "perennials"
	| "annual-flowers" | "vegetable-garden" | "native";

export interface PlantKc {
	/** Dormant-season (winter) crop coefficient floor. */
	dormantKc: number;
	/** Peak growing-season (summer) crop coefficient. */
	peakKc: number;
	/** Day-of-year of the seasonal peak (Northern hemisphere). Defaults to 196 (~Jul 15). */
	peakDay?: number;
}

export const KC_MIN = 0.1;
export const KC_MAX = 1.5;
const DEFAULT_PEAK_DAY = 196;

/** Named plant presets -> seasonal Kc curve parameters. Approximate FAO-56 / WUCOLS values. */
export const PLANT_KC_CATALOG: { [ k: string ]: PlantKc } = {
	"trees":            { dormantKc: 0.40, peakKc: 0.65 },
	"shrubs":           { dormantKc: 0.30, peakKc: 0.50 },
	"groundcover":      { dormantKc: 0.30, peakKc: 0.50 },
	"perennials":       { dormantKc: 0.20, peakKc: 0.50 },
	"annual-flowers":   { dormantKc: 0.20, peakKc: 0.80 },
	"vegetable-garden": { dormantKc: 0.30, peakKc: 1.00 },
	"native":           { dormantKc: 0.15, peakKc: 0.30 }
};

/**
 * Coerce a value to a finite crop coefficient clamped to [KC_MIN, KC_MAX], or undefined if the
 * value is not a finite number. Used so a junk override falls through instead of zeroing watering.
 */
export function clampKc( value: any ): number | undefined {
	if ( value === undefined || value === null ) return undefined;
	const n = Number( value );
	if ( !Number.isFinite( n ) ) return undefined;
	return Math.min( KC_MAX, Math.max( KC_MIN, n ) );
}

/**
 * Seasonal crop coefficient for a plant preset on a given day-of-year. Cosine interpolation
 * between the dormant floor (winter) and the peak (summer); peaks at `peakDay`. Northern
 * hemisphere. Returns a value rounded to 2 decimals, always within [dormantKc, peakKc].
 * Falls back to 1.0 for an unknown plant type.
 */
export function getPlantKc( plantType: string, dayOfYear: number ): number {
	const plant = PLANT_KC_CATALOG[ plantType ];
	if ( !plant ) return 1.0;
	const peakDay = plant.peakDay === undefined ? DEFAULT_PEAK_DAY : plant.peakDay;
	const phase = ( ( dayOfYear - peakDay ) / 365 ) * 2 * Math.PI;
	const kc = plant.dormantKc + ( plant.peakKc - plant.dormantKc ) * ( 1 + Math.cos( phase ) ) / 2;
	return Math.round( kc * 100 ) / 100;
}

export interface CropCoefficientResult {
	kc: number;
	factors: any;
}

/**
 * Resolve the crop coefficient by precedence:
 *   1. customCropCoefficient override (finite, clamped to [KC_MIN, KC_MAX])
 *   2. a known plantType preset's seasonal Kc curve
 *   3. turfFallback() — the existing TurfgrassManager grass path (unchanged)
 * `turfFallback` is injected so this module never imports TurfgrassManager (no cycle) and stays
 * unit-testable. `env` is injectable for tests; defaults to process.env.
 */
export function resolveCropCoefficient(
	opts: { customCropCoefficient?: number; plantType?: string },
	dayOfYear: number,
	turfFallback: () => CropCoefficientResult,
	env: { [ k: string ]: string | undefined } = process.env as any
): CropCoefficientResult {
	const rawOverride = opts.customCropCoefficient !== undefined ? opts.customCropCoefficient : env.CUSTOM_CROP_COEFFICIENT;
	const override = clampKc( rawOverride );
	if ( override !== undefined ) {
		return { kc: override, factors: { source: "override" } };
	}
	const plantType = opts.plantType !== undefined ? opts.plantType : env.PLANT_TYPE;
	if ( plantType && PLANT_KC_CATALOG[ plantType ] ) {
		return { kc: getPlantKc( plantType, dayOfYear ), factors: { source: "plant", plantType } };
	}
	return turfFallback();
}
