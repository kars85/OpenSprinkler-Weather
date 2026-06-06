import { expect } from "chai";
import { createPublisher, gatherState, GatherDeps } from "./MqttPublisher";
import { MqttConfig } from "./config";

const config: MqttConfig = {
	brokerUrl: "mqtt://h", location: "1,2", adjustmentParam: 4,
	topicPrefix: "p", discoveryPrefix: "homeassistant", deviceId: "osw", intervalMs: 60000
};

function fakeClient() {
	const published: { topic: string; payload: string; retain: boolean }[] = [];
	return {
		published,
		publish( topic: string, payload: string, opts: any, cb?: ( e?: any ) => void ) {
			published.push( { topic, payload, retain: !!( opts && opts.retain ) } );
			if ( cb ) cb();
		},
		on() { /* no-op */ }
	};
}

const okDeps = ( over: Partial<GatherDeps> = {} ): GatherDeps => ( {
	resolveCoordinates: async () => [ 1, 2 ],
	buildPwsFromParams: () => undefined,
	computeWateringDecision: async () => ( { coordinates: [ 1, 2 ], methodId: 4, methodName: "waterBudget", scale: 80, rainDelay: 0, rawData: { wp: "OWM", reason: "r" }, weatherProvider: "OWM", skip: false, servedFallback: false, pwsBypassed: false } as any ),
	resolveWeatherProvider: () => ( { getWeatherData: async () => ( { weatherProvider: "OWM", temp: 70, humidity: 50, wind: 5, precip: 0, minTemp: 60, maxTemp: 80, description: "Clear", icon: "01d" } ) } as any ),
	getBudgetState: async () => ( { rainBank: 0.5, lastUpdated: "2024-07-15", lastScale: 80, history: [] } ),
	...over
} );

describe( "gatherState", () => {
	it( "collects watering, weather and budget when all succeed", async () => {
		const s = await gatherState( config, okDeps() );
		expect( s.status.ok ).to.equal( true );
		expect( s.watering.scale ).to.equal( 80 );
		expect( s.weather.temp ).to.equal( 70 );
		expect( s.budget.rainBank ).to.equal( 0.5 );
	} );

	it( "omits a failed section and marks status not-ok, keeping the others", async () => {
		const s = await gatherState( config, okDeps( { resolveWeatherProvider: () => ( { getWeatherData: async () => { throw new Error( "boom" ); } } as any ) } ) );
		expect( s.watering ).to.be.an( "object" );
		expect( s.weather ).to.equal( undefined );
		expect( s.status.ok ).to.equal( false );
	} );

	it( "omits budget when there is no stored state", async () => {
		const s = await gatherState( config, okDeps( { getBudgetState: async () => undefined } ) );
		expect( s.budget ).to.equal( undefined );
		expect( s.status.ok ).to.equal( true );
	} );
} );

describe( "createPublisher", () => {
	it( "publishes online + discovery + a state tick on connect", async () => {
		const client = fakeClient();
		const pub = createPublisher( config, client as any, async () => ( { watering: { scale: 80 }, weather: { temp: 70 }, status: { ok: true } } ) );
		await pub.onConnect();
		const topics = client.published.map( p => p.topic );
		expect( topics ).to.include( "p/osw/availability" );
		expect( topics.some( t => t.indexOf( "homeassistant/" ) === 0 ) ).to.equal( true );
		expect( topics ).to.include( "p/osw/watering" );
		const avail = client.published.find( p => p.topic === "p/osw/availability" )!;
		expect( avail.payload ).to.equal( "online" );
		expect( avail.retain ).to.equal( true );
	} );

	it( "skips an overlapping tick while one is in flight", async () => {
		const client = fakeClient();
		let release: () => void;
		const gate = new Promise< void >( r => { release = r; } );
		let calls = 0;
		const pub = createPublisher( config, client as any, async () => { calls++; await gate; return { status: { ok: true } }; } );
		const first = pub.tick();
		const second = pub.tick();   // should be skipped (inFlight)
		release!();
		await Promise.all( [ first, second ] );
		expect( calls ).to.equal( 1 );
	} );
} );
