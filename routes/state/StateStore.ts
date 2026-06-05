import * as fs from "fs";
import { BudgetState } from "../adjustmentMethods/SoilMoistureModel";

/**
 * Persistence seam for water-budget state. The async signature lets a future
 * remote adapter (S3/Redis/Dynamo) drop in unchanged for the hosted service.
 */
export interface StateStore {
	get( key: string ): Promise< BudgetState | undefined >;
	set( key: string, state: BudgetState ): Promise< void >;
}

/**
 * Single-file JSON store. Loads once into an in-memory map (the runtime source
 * of truth) and flushes atomically (temp file -> rename). In-memory-first avoids
 * read-modify-write races and disk thrash. Suited to the self-hosted single/few
 * location case.
 */
export class FileStateStore implements StateStore {
	private readonly path: string;
	private cache: { [ key: string ]: BudgetState } = {};
	private loaded = false;

	public constructor( filePath: string ) {
		this.path = filePath;
	}

	private load(): void {
		if ( this.loaded ) return;
		this.loaded = true;
		try {
			if ( fs.existsSync( this.path ) ) {
				const parsed = JSON.parse( fs.readFileSync( this.path, "utf8" ) );
				if ( parsed && typeof parsed === "object" ) this.cache = parsed;
			}
		} catch ( err ) {
			console.error( "WaterBudget: failed to load state file; starting empty.", err );
			this.cache = {};
		}
	}

	public async get( key: string ): Promise< BudgetState | undefined > {
		this.load();
		return this.cache[ key ];
	}

	public async set( key: string, state: BudgetState ): Promise< void > {
		this.load();
		this.cache[ key ] = state;
		const tmp = `${ this.path }.${ process.pid }.tmp`;
		fs.writeFileSync( tmp, JSON.stringify( this.cache ) );
		fs.renameSync( tmp, this.path );
	}
}
