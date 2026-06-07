# Dashboard UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a zero-build static `/dashboard` page (HTML + vanilla JS + hand-rolled SVG) served by Express, visualizing the `/v1` watering/weather/budget data, with XSS-safe rendering and pure testable helpers.

**Architecture:** Browser assets under `public/dashboard/` (no compilation). The logic lives in a UMD `format.js` (browser `<script>` + Node `require` for tests); `app.js` is a thin `textContent`-only shell. `server.ts` mounts `express.static` after an existence check. No new dependencies, no build step.

**Tech Stack:** TypeScript/Express backend (unchanged); browser ES5-compatible vanilla JS; mocha + chai (existing) for the pure helpers + an HTML-scan test.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `public/dashboard/format.js` | Pure UMD helpers: `parseParams`, `buildRequestUrls`, `buildViewModel`, `buildHistoryPath`. | Create |
| `public/dashboard/format.spec.ts` | Unit tests for the helpers. | Create |
| `public/dashboard/index.html` | Markup + CSP meta; no inline JS. | Create |
| `public/dashboard/app.js` | Thin browser shell (fetch + textContent render). | Create |
| `public/dashboard/style.css` | Minimal styling. | Create |
| `public/dashboard/dashboard-html.spec.ts` | Asserts `index.html` structure + no inline JS. | Create |
| `.mocharc.json` | Add `public` to the spec glob. | Modify |
| `server.ts` | Resolve + existence-check `public/dashboard`; mount `express.static` before the 404 handler. | Modify |
| `docs/dashboard.md` + `README.md` | Usage guide + link. | Create/Modify |

**Test commands:** subset → `npm test -- --grep "<name>"`; full → `npm test`; type-check → `npm run compile`.

> **Empirica note (this session only):** the sentinel firewall gates praxic commands. If a `git`/`npm`/Edit call is denied with `Epistemic loop closed` / `Run new PREFLIGHT`, open a transaction first: `empirica preflight-submit -` then `empirica check-submit -` (JSON via heredoc with `vectors`; check also needs `phase:"praxic"`). Close with `empirica postflight-submit -`.

---

## Task 1: `format.js` pure helpers + tests

**Files:**
- Create: `public/dashboard/format.js`, `public/dashboard/format.spec.ts`
- Modify: `.mocharc.json`

- [ ] **Step 1: Add `public` to the mocha spec glob.** In `.mocharc.json`, change `"spec": "{routes,test,mqtt}/**/*.spec.ts"` to:

```json
  "spec": "{routes,test,mqtt,public}/**/*.spec.ts",
```

- [ ] **Step 2: Write the failing tests.** Create `public/dashboard/format.spec.ts`:

```typescript
import { expect } from "chai";
const F = require( "./format.js" );

function memStore() {
	const m: { [ k: string ]: string } = {};
	return { getItem: ( k: string ) => ( k in m ? m[ k ] : null ), setItem: ( k: string, v: string ) => { m[ k ] = v; } };
}

describe( "dashboard format.parseParams", () => {
	it( "prefers URL, then store, then defaults; persists resolved values", () => {
		const s = memStore();
		expect( F.parseParams( "?loc=1,2&method=3", s ) ).to.deep.equal( { loc: "1,2", method: 3 } );
		expect( s.getItem( "osw_loc" ) ).to.equal( "1,2" );
		expect( F.parseParams( "", s ) ).to.deep.equal( { loc: "1,2", method: 3 } ); // store fallback
	} );
	it( "defaults method to 4 and rejects invalid/out-of-range", () => {
		expect( F.parseParams( "?loc=x", memStore() ).method ).to.equal( 4 );
		expect( F.parseParams( "?loc=x&method=9", memStore() ).method ).to.equal( 4 );
		expect( F.parseParams( "?loc=x&method=abc", memStore() ).method ).to.equal( 4 );
	} );
} );

describe( "dashboard format.buildRequestUrls", () => {
	it( "encodes loc and builds the three urls", () => {
		const u = F.buildRequestUrls( { loc: "42.3,-72.5", method: 4 } );
		expect( u.watering ).to.equal( "/v1/watering?loc=42.3%2C-72.5&method=4" );
		expect( u.weather ).to.equal( "/v1/weather?loc=42.3%2C-72.5" );
		expect( u.budget ).to.equal( "/v1/budget?loc=42.3%2C-72.5" );
	} );
} );

describe( "dashboard format.buildViewModel", () => {
	it( "maps watering/weather and budget history", () => {
		const vm = F.buildViewModel( {
			watering: { scale: 80, rainDelay: 0, methodName: "waterBudget", skip: false, reason: "dry", weatherProvider: "OWM", pwsBypassed: false },
			weather: { temp: 70, humidity: 50, wind: 5, precip: 0, minTemp: 60, maxTemp: 80, description: "Clear", weatherProvider: "OWM" },
			budget: { rainBank: 0.5, history: [ { date: "2024-07-15", scale: 80, reason: "dry" } ] }
		} );
		expect( vm.watering.scale ).to.equal( 80 );
		expect( vm.weather.temp ).to.equal( 70 );
		expect( vm.history ).to.deep.equal( [ 80 ] );
		expect( vm.decisions[ 0 ].reason ).to.equal( "dry" );
		expect( vm.budgetEmpty ).to.equal( false );
	} );
	it( "treats budget 404/absent as empty (not error)", () => {
		const vm = F.buildViewModel( { watering: { scale: 100 }, weather: {}, budget: { error: { code: "no_budget_state" } } } );
		expect( vm.budgetEmpty ).to.equal( true );
		expect( vm.history ).to.deep.equal( [] );
		expect( vm.decisions ).to.deep.equal( [] );
	} );
	it( "surfaces a watering error message without throwing", () => {
		const vm = F.buildViewModel( { watering: { error: { message: "bad loc" } }, weather: {}, budget: null } );
		expect( vm.watering.error ).to.equal( "bad loc" );
	} );
} );

describe( "dashboard format.buildHistoryPath", () => {
	it( "empty -> no points", () => { expect( F.buildHistoryPath( [], 100, 50 ) ).to.deep.equal( { points: "", min: 0, max: 0 } ); } );
	it( "single -> centered", () => { expect( F.buildHistoryPath( [ 80 ], 100, 50 ).points ).to.equal( "50,25" ); } );
	it( "all-equal -> midline, no NaN", () => {
		const r = F.buildHistoryPath( [ 5, 5, 5 ], 100, 50 );
		expect( r.points.indexOf( "NaN" ) ).to.equal( -1 );
		expect( r.min ).to.equal( 5 ); expect( r.max ).to.equal( 5 );
	} );
	it( "non-finite coerced (no NaN)", () => {
		expect( F.buildHistoryPath( [ NaN, 10 ] as any, 100, 50 ).points.indexOf( "NaN" ) ).to.equal( -1 );
	} );
	it( "monotonic series maps min->bottom, max->top", () => {
		expect( F.buildHistoryPath( [ 0, 100 ], 100, 50 ).points ).to.equal( "2,48 98,2" );
	} );
} );
```

- [ ] **Step 3: Run the tests to verify they fail.**

Run: `npm test -- --grep "dashboard format"`
Expected: FAIL — `Cannot find module './format.js'`.

- [ ] **Step 4: Write the implementation.** Create `public/dashboard/format.js`:

```javascript
/*
 * Pure dashboard helpers. UMD-style: loaded in the browser via <script> (exposes window.OSWFormat)
 * AND require()-able by Node/mocha for tests. DO NOT convert to an ES module or TypeScript — that
 * would break the dual browser+test load. ES5-compatible (no arrow funcs / template literals).
 */
( function ( root ) {
	function isFiniteNum( x ) { return typeof x === "number" && isFinite( x ); }
	function num( x ) { return isFiniteNum( x ) ? x : null; }
	function round2( n ) { return Math.round( n * 100 ) / 100; }
	function errOf( o ) { return o && o.error ? ( o.error.message || o.error.code || "error" ) : null; }

	function parseParams( search, store ) {
		var params = new URLSearchParams( search || "" );
		var loc = params.get( "loc" );
		if ( loc === null && store && store.getItem ) loc = store.getItem( "osw_loc" );
		loc = loc === null || loc === undefined ? "" : String( loc );
		var mRaw = params.get( "method" );
		if ( mRaw === null && store && store.getItem ) mRaw = store.getItem( "osw_method" );
		var method = parseInt( mRaw, 10 );
		if ( isNaN( method ) || method < 0 || method > 4 ) method = 4;
		if ( store && store.setItem ) { store.setItem( "osw_loc", loc ); store.setItem( "osw_method", String( method ) ); }
		return { loc: loc, method: method };
	}

	function buildRequestUrls( p ) {
		var loc = encodeURIComponent( p.loc );
		return {
			watering: "/v1/watering?loc=" + loc + "&method=" + p.method,
			weather: "/v1/weather?loc=" + loc,
			budget: "/v1/budget?loc=" + loc
		};
	}

	function buildViewModel( data ) {
		data = data || {};
		var w = data.watering || {}, we = data.weather || {}, b = data.budget;
		var watering = {
			scale: num( w.scale ), rainDelay: num( w.rainDelay ),
			method: w.methodName || w.method || "", skip: !!w.skip,
			reason: w.reason || "", weatherProvider: w.weatherProvider || "",
			pwsBypassed: !!w.pwsBypassed, error: errOf( w )
		};
		var weather = {
			temp: num( we.temp ), humidity: num( we.humidity ), wind: num( we.wind ), precip: num( we.precip ),
			minTemp: num( we.minTemp ), maxTemp: num( we.maxTemp ),
			description: we.description || "", weatherProvider: we.weatherProvider || "", error: errOf( we )
		};
		var history = [], decisions = [], budgetEmpty = true, rainBank = null;
		if ( b && !b.error && b.history && b.history.length ) {
			budgetEmpty = false;
			rainBank = num( b.rainBank );
			for ( var i = 0; i < b.history.length; i++ ) {
				var r = b.history[ i ];
				history.push( isFiniteNum( r.scale ) ? r.scale : 0 );
				decisions.push( { date: r.date || "", scale: num( r.scale ), reason: r.reason || "" } );
			}
		}
		return { watering: watering, weather: weather, history: history, decisions: decisions, rainBank: rainBank, budgetEmpty: budgetEmpty };
	}

	function buildHistoryPath( values, w, h ) {
		var nums = [];
		for ( var i = 0; i < ( values || [] ).length; i++ ) nums.push( isFiniteNum( values[ i ] ) ? values[ i ] : 0 );
		if ( nums.length === 0 ) return { points: "", min: 0, max: 0 };
		var min = Math.min.apply( null, nums ), max = Math.max.apply( null, nums ), span = max - min, pad = 2;
		var pts = [];
		for ( var j = 0; j < nums.length; j++ ) {
			var x = nums.length === 1 ? w / 2 : pad + ( j / ( nums.length - 1 ) ) * ( w - 2 * pad );
			var y = span === 0 ? h / 2 : pad + ( 1 - ( nums[ j ] - min ) / span ) * ( h - 2 * pad );
			pts.push( round2( x ) + "," + round2( y ) );
		}
		return { points: pts.join( " " ), min: min, max: max };
	}

	var api = { parseParams: parseParams, buildRequestUrls: buildRequestUrls, buildViewModel: buildViewModel, buildHistoryPath: buildHistoryPath };
	if ( typeof module !== "undefined" && module.exports ) module.exports = api;
	else root.OSWFormat = api;
} )( typeof window !== "undefined" ? window : this );
```

- [ ] **Step 4b: Run the tests to verify they pass.**

Run: `npm test -- --grep "dashboard format"` → PASS. Run `npm run compile` → clean. Run `npm test` → all pass.

- [ ] **Step 5: Commit.**

```bash
git add public/dashboard/format.js public/dashboard/format.spec.ts .mocharc.json
git commit -m "feat(dashboard): pure format helpers (UMD) + tests [#dashboard]"
```

---

## Task 2: Static page (`index.html`, `app.js`, `style.css`) + HTML scan test

**Files:**
- Create: `public/dashboard/index.html`, `public/dashboard/app.js`, `public/dashboard/style.css`, `public/dashboard/dashboard-html.spec.ts`

- [ ] **Step 1: Write the failing HTML-scan test.** Create `public/dashboard/dashboard-html.spec.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npm test -- --grep "dashboard index.html"`
Expected: FAIL — `ENOENT ... index.html`.

- [ ] **Step 3: Write `index.html`.** Create `public/dashboard/index.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="default-src 'self'">
	<title>OpenSprinkler Weather Dashboard</title>
	<link rel="stylesheet" href="style.css">
</head>
<body>
	<header>
		<h1>OpenSprinkler Weather</h1>
		<div class="bar">
			<input id="loc-input" placeholder="lat,lon or location" aria-label="Location">
			<input id="method-input" type="number" min="0" max="4" aria-label="Adjustment method">
			<button id="refresh-btn">Refresh</button>
		</div>
		<p id="error" class="error"></p>
	</header>

	<section id="cards" class="cards">
		<div class="card"><span class="k">Scale</span><span class="v" id="card-scale">&mdash;</span></div>
		<div class="card"><span class="k">Method</span><span class="v" id="card-method">&mdash;</span></div>
		<div class="card"><span class="k">Skip</span><span class="v" id="card-skip">&mdash;</span></div>
		<div class="card"><span class="k">Provider</span><span class="v" id="card-provider">&mdash;</span></div>
		<div class="card"><span class="k">Temp</span><span class="v" id="card-temp">&mdash;</span></div>
		<div class="card"><span class="k">Humidity</span><span class="v" id="card-humidity">&mdash;</span></div>
		<div class="card"><span class="k">Wind</span><span class="v" id="card-wind">&mdash;</span></div>
		<div class="card"><span class="k">Precip</span><span class="v" id="card-precip">&mdash;</span></div>
		<div class="card"><span class="k">Rain bank</span><span class="v" id="card-rainbank">&mdash;</span></div>
	</section>

	<section class="chart">
		<h2>Watering scale history</h2>
		<svg id="history-chart" viewBox="0 0 300 80" preserveAspectRatio="none" role="img" aria-label="Watering scale history">
			<polyline id="history-line" fill="none" stroke="#2a7" stroke-width="1.5" points=""></polyline>
		</svg>
		<div class="chart-axis"><span id="chart-min">&mdash;</span><span id="chart-max">&mdash;</span></div>
	</section>

	<section class="decisions">
		<h2>Recent decisions</h2>
		<table>
			<thead><tr><th>Date</th><th>Scale</th><th>Reason</th></tr></thead>
			<tbody id="decisions-body"></tbody>
		</table>
	</section>

	<script src="format.js"></script>
	<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 4: Write `style.css`.** Create `public/dashboard/style.css`:

```css
body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; color: #222; background: #f7f7f7; }
h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
h2 { font-size: 1rem; margin: 1rem 0 .5rem; }
.bar { display: flex; gap: .5rem; flex-wrap: wrap; }
.bar input { padding: .4rem; border: 1px solid #ccc; border-radius: 4px; }
.bar button { padding: .4rem .8rem; border: 0; border-radius: 4px; background: #2a7; color: #fff; cursor: pointer; }
.error { color: #b00; min-height: 1.2em; margin: .5rem 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: .5rem; }
.card { background: #fff; border: 1px solid #e3e3e3; border-radius: 6px; padding: .5rem .6rem; display: flex; flex-direction: column; }
.card .k { font-size: .7rem; color: #777; text-transform: uppercase; }
.card .v { font-size: 1.1rem; font-weight: 600; }
.chart svg { width: 100%; height: 120px; background: #fff; border: 1px solid #e3e3e3; border-radius: 6px; }
.chart-axis { display: flex; justify-content: space-between; font-size: .7rem; color: #777; }
.decisions table { width: 100%; border-collapse: collapse; background: #fff; }
.decisions th, .decisions td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #eee; font-size: .85rem; }
```

- [ ] **Step 5: Write `app.js`.** Create `public/dashboard/app.js`:

```javascript
/* Thin browser shell. ALL dynamic content is written via textContent / setAttribute — never innerHTML. */
( function () {
	var F = window.OSWFormat;
	function $( id ) { return document.getElementById( id ); }
	var inFlight = false, timer = null;

	function setText( el, s ) { el.textContent = ( s === null || s === undefined || s === "" ) ? "—" : String( s ); }
	function unit( v, u ) { return v === null ? null : v + u; }

	function fetchJSON( url ) {
		return fetch( url, { cache: "no-store" } ).then( function ( res ) {
			return res.json().catch( function () { return null; } ).then( function ( body ) {
				if ( !res.ok ) return { error: ( body && body.error ) || { code: res.status, message: "HTTP " + res.status } };
				return body || { error: { message: "empty response" } };
			} );
		} );
	}

	function renderCards( vm ) {
		setText( $( "card-scale" ), unit( vm.watering.scale, "%" ) );
		setText( $( "card-method" ), vm.watering.method );
		setText( $( "card-skip" ), vm.watering.skip ? ( "Yes — " + vm.watering.reason ) : "No" );
		setText( $( "card-provider" ), vm.watering.weatherProvider );
		setText( $( "card-temp" ), unit( vm.weather.temp, "°F" ) );
		setText( $( "card-humidity" ), unit( vm.weather.humidity, "%" ) );
		setText( $( "card-wind" ), unit( vm.weather.wind, " mph" ) );
		setText( $( "card-precip" ), unit( vm.weather.precip, " in" ) );
		setText( $( "card-rainbank" ), unit( vm.rainBank, " in" ) );
	}

	function renderChart( history ) {
		var svg = $( "history-chart" );
		var vb = svg.viewBox.baseVal;
		var r = F.buildHistoryPath( history, vb.width || 300, vb.height || 80 );
		$( "history-line" ).setAttribute( "points", r.points );
		setText( $( "chart-min" ), history.length ? r.min : "" );
		setText( $( "chart-max" ), history.length ? r.max : "" );
	}

	function renderDecisions( decisions ) {
		var tbody = $( "decisions-body" );
		while ( tbody.firstChild ) tbody.removeChild( tbody.firstChild );
		if ( !decisions.length ) {
			var tr0 = document.createElement( "tr" ), td0 = document.createElement( "td" );
			td0.setAttribute( "colspan", "3" ); td0.textContent = "No decisions yet.";
			tr0.appendChild( td0 ); tbody.appendChild( tr0 ); return;
		}
		for ( var i = decisions.length - 1; i >= 0; i-- ) {
			var d = decisions[ i ], tr = document.createElement( "tr" );
			var cells = [ d.date, d.scale === null ? "—" : d.scale + "%", d.reason ];
			for ( var c = 0; c < cells.length; c++ ) {
				var td = document.createElement( "td" ); td.textContent = String( cells[ c ] ); tr.appendChild( td );
			}
			tbody.appendChild( tr );
		}
	}

	function load() {
		if ( inFlight ) return;
		inFlight = true;
		setText( $( "error" ), "" );
		var p = F.parseParams( window.location.search, window.localStorage );
		$( "loc-input" ).value = p.loc;
		$( "method-input" ).value = String( p.method );
		var urls = F.buildRequestUrls( p );
		Promise.all( [ fetchJSON( urls.watering ), fetchJSON( urls.weather ), fetchJSON( urls.budget ) ] ).then( function ( res ) {
			var vm = F.buildViewModel( { watering: res[ 0 ], weather: res[ 1 ], budget: res[ 2 ] } );
			renderCards( vm ); renderChart( vm.history ); renderDecisions( vm.decisions );
			if ( vm.watering.error ) setText( $( "error" ), "Watering: " + vm.watering.error );
		} ).catch( function () {
			setText( $( "error" ), "Couldn't reach the service." );
		} ).then( function () { inFlight = false; } );
	}

	function restart() { if ( timer ) clearInterval( timer ); load(); timer = setInterval( load, 5 * 60 * 1000 ); }

	document.addEventListener( "DOMContentLoaded", function () {
		$( "refresh-btn" ).addEventListener( "click", function () {
			var qs = "?loc=" + encodeURIComponent( $( "loc-input" ).value ) + "&method=" + encodeURIComponent( $( "method-input" ).value );
			window.history.replaceState( null, "", qs );
			restart();
		} );
		restart();
	} );
} )();
```

- [ ] **Step 6: Run the HTML test + full suite.**

Run: `npm test -- --grep "dashboard index.html"` → PASS.
Run: `npm test` → all pass. Run `npm run compile` → clean.

- [ ] **Step 7: Commit.**

```bash
git add public/dashboard/index.html public/dashboard/app.js public/dashboard/style.css public/dashboard/dashboard-html.spec.ts
git commit -m "feat(dashboard): static page (cards, SVG history, decisions) + HTML-scan test [#dashboard]"
```

---

## Task 3: Serve `/dashboard` from `server.ts`

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Add the static mount with an existence check.** In `server.ts`, add near the top imports:

```typescript
import * as path from "path";
import * as fs from "fs";
```

  Then, in the route-registration section **before** the 404 handler (`app.use( function( req, res ) { res.status( 404 ); ... } )`), add:

```typescript
// Serve the static dashboard (zero-build). Resolve across run modes (cwd, compiled js/, ts-node).
const dashboardCandidates = [
	path.join( process.cwd(), "public", "dashboard" ),
	path.join( __dirname, "..", "public", "dashboard" ),
	path.join( __dirname, "public", "dashboard" )
];
const dashboardDir = dashboardCandidates.filter( function ( d ) { return fs.existsSync( d ); } )[ 0 ];
if ( dashboardDir ) {
	app.use( "/dashboard", cors(), express.static( dashboardDir, { dotfiles: "deny", index: "index.html" } ) );
	console.log( "Dashboard available at /dashboard (from %s)", dashboardDir );
} else {
	console.warn( "Dashboard assets not found (looked in: %s); /dashboard disabled.", dashboardCandidates.join( ", " ) );
}
```

  (`cors` and `express` are already imported in `server.ts`.)

- [ ] **Step 2: Verify build + suite.**

Run: `npm run compile` → clean.
Run: `npm test` → all pass (tests import `./routes/...`, not `server.ts`, so unaffected).

- [ ] **Step 3: Manual smoke (optional, document the result).** Start the server and `curl -s http://127.0.0.1:3000/dashboard/ | head` — expect the dashboard HTML. (Not an automated test; the static mount + existence check mirror the repo's untested-bootstrap posture.)

- [ ] **Step 4: Commit.**

```bash
git add server.ts
git commit -m "feat(dashboard): mount /dashboard static assets (existence-checked, dotfiles denied) [#dashboard]"
```

---

## Task 4: Documentation

**Files:**
- Create: `docs/dashboard.md`
- Modify: `README.md`

- [ ] **Step 1: Write the docs.** Create `docs/dashboard.md`:

```markdown
# Dashboard

A lightweight web dashboard at **`/dashboard`** that visualizes the `/v1` data — current
watering decision, weather, the Water-Budget rain-bank, a watering-scale history chart, and
recent decisions. It ships with the service (no build step, no extra dependency).

## Usage

Open `http://<host>:<port>/dashboard/` and enter a location (`lat,lon` or a geocodable string)
and an adjustment method (0 manual, 1 zimmerman, 2 rainDelay, 3 eto, 4 waterBudget). The
selection is saved to the URL (`?loc=...&method=4`) and `localStorage`, so you can bookmark it.
The page auto-refreshes every 5 minutes (and on the Refresh button).

The history chart and decisions appear once the Water-Budget method (4) has run for that
location at least once; before then they show an empty state.

## Security / scope

The dashboard and the `/v1` API it reads are **read-only and unauthenticated** — intended for
self-hosted/home use on a trusted network. All data is rendered as text (no HTML injection), and
the page loads only local assets (a `default-src 'self'` CSP, no CDN). It does not control the
controller; it only displays what the service computes.
```

  Add to `README.md` near the other docs links:

```markdown
- For the **web dashboard** (`/dashboard`: watering decision, weather, budget history), see [here](docs/dashboard.md)
```

- [ ] **Step 2: Verify + commit.**

Run: `npm run compile` (clean).

```bash
git add docs/dashboard.md README.md
git commit -m "docs(dashboard): usage + security guide [#dashboard]"
```

---

## Done criteria

- `npm test` green (existing suites + new `format` helper tests + the `index.html` scan test), `npm run compile` clean.
- `/dashboard` serves the static page; it fetches `/v1` (no-store), renders cards + an SVG history chart + a decisions table via `textContent`, handles a `/v1/budget` 404 as an empty state, and auto-refreshes without overlapping polls.
- No inline scripts/handlers in `index.html`; `default-src 'self'` CSP present; `express.static` denies dotfiles and is existence-checked (no silent 404).
- No new npm dependencies; no build tooling.

## Out of scope (per spec)
- Auth, write/control, multi-site, real-time push, chart tooltips/zoom/date-range/multi-series, any bundler/framework/CDN, jsdom test stack, `/v1` CORS broadening.
