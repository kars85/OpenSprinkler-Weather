/* Thin browser shell. ALL dynamic content is written via textContent / setAttribute — never innerHTML. */
( function () {
	var F = window.OSWFormat;
	function $( id ) { return document.getElementById( id ); }
	var inFlight = false, timer = null;

	function setText( el, s ) { el.textContent = ( s === null || s === undefined || s === "" ) ? "—" : String( s ); }
	function unit( v, u ) { return v === null ? null : v + u; }

	function fetchJSON( url ) {
		var timeout;
		var request = fetch( url, { cache: "no-store" } ).then( function ( res ) {
			return res.json().catch( function () { return null; } ).then( function ( body ) {
				if ( !res.ok ) return { error: ( body && body.error ) || { code: res.status, message: "HTTP " + res.status } };
				return body || { error: { message: "empty response" } };
			} );
		} );
		var timed = new Promise( function ( resolve, reject ) {
			timeout = setTimeout( function () { reject( new Error( "request timed out" ) ); }, 15000 );
		} );
		return Promise.race( [ request, timed ] ).then( function ( body ) {
			clearTimeout( timeout );
			return body;
		}, function ( err ) {
			clearTimeout( timeout );
			throw err;
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
		var vb = ( svg && svg.viewBox && svg.viewBox.baseVal ) || {};
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
			var errors = [];
			if ( vm.watering.error ) errors.push( "Watering: " + vm.watering.error );
			if ( vm.weather.error ) errors.push( "Weather: " + vm.weather.error );
			if ( errors.length ) setText( $( "error" ), errors.join( " " ) );
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
