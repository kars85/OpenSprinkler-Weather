import { expect } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileStateStore } from "./StateStore";
import { BudgetState } from "../adjustmentMethods/SoilMoistureModel";

let counter = 0;
function tmpFile(): string {
	return path.join( os.tmpdir(), `wb-state-${ process.pid }-${ counter++ }.json` );
}

const sample: BudgetState = { rainBank: 0.4, lastUpdated: "2019-05-13", lastScale: 75, history: [] };

describe( "FileStateStore", () => {
	it( "returns undefined for an unknown key", async () => {
		const store = new FileStateStore( tmpFile() );
		expect( await store.get( "nope" ) ).to.equal( undefined );
	} );

	it( "round-trips a value within an instance", async () => {
		const store = new FileStateStore( tmpFile() );
		await store.set( "42.37,-72.52", sample );
		expect( await store.get( "42.37,-72.52" ) ).to.deep.equal( sample );
	} );

	it( "persists across instances (survives restart)", async () => {
		const file = tmpFile();
		await new FileStateStore( file ).set( "k", sample );
		const reloaded = new FileStateStore( file );
		expect( await reloaded.get( "k" ) ).to.deep.equal( sample );
	} );

	it( "writes atomically and leaves no temp file behind", async () => {
		const file = tmpFile();
		const store = new FileStateStore( file );
		await store.set( "k", sample );
		expect( fs.existsSync( file ) ).to.equal( true );
		const leftovers = fs.readdirSync( os.tmpdir() ).filter( f => f.startsWith( path.basename( file ) ) && f.endsWith( ".tmp" ) );
		expect( leftovers ).to.have.length( 0 );
	} );

	it( "recovers from a corrupt state file (starts empty, no throw)", async () => {
		const file = tmpFile();
		fs.writeFileSync( file, "{ this is not valid json" );
		const store = new FileStateStore( file );
		expect( await store.get( "k" ) ).to.equal( undefined );
		await store.set( "k", sample );
		expect( await store.get( "k" ) ).to.deep.equal( sample );
	} );
} );
