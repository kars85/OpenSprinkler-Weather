import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

const html = fs.readFileSync( path.join( __dirname, "index.html" ), "utf8" );

describe( "dashboard index.html", () => {
	it( "has the expected mount-point ids", () => {
		for ( const id of [ "loc-input", "method-input", "refresh-btn", "cards", "history-chart", "history-line", "decisions-body", "error" ] ) {
			expect( html, "missing #" + id ).to.contain( 'id="' + id + '"' );
		}
	} );
	it( "references only the local scripts", () => {
		expect( html ).to.contain( 'src="format.js"' );
		expect( html ).to.contain( 'src="app.js"' );
		expect( html ).to.not.match( /src="https?:/ ); // no CDN
	} );
	it( "has no inline <script> and no inline event handlers", () => {
		expect( /<script(?![^>]*\bsrc=)[^>]*>/.test( html ), "inline <script> found" ).to.equal( false );
		expect( /\son\w+\s*=/.test( html ), "inline on*= handler found" ).to.equal( false );
	} );
	it( "declares a default-src 'self' CSP", () => {
		expect( html ).to.contain( "Content-Security-Policy" );
		expect( html ).to.contain( "default-src 'self'" );
	} );
} );
