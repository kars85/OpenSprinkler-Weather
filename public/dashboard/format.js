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
