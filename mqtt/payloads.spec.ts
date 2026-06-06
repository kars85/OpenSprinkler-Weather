import { expect } from "chai";
import { buildDiscoveryConfigs, buildStatePayloads } from "./payloads";

describe( "buildStatePayloads", () => {
	const base = { watering: { scale: 80 }, weather: { temp: 70 }, status: { ok: true } };

	it( "emits retained watering/weather/status topics and JSON payloads", () => {
		const items = buildStatePayloads( "osw", "osw-weather", base as any );
		const topics = items.map( i => i.topic );
		expect( topics ).to.include( "osw-weather/osw/watering" );
		expect( topics ).to.include( "osw-weather/osw/weather" );
		expect( topics ).to.include( "osw-weather/osw/status" );
		expect( items.every( i => i.retain === true ) ).to.equal( true );
		expect( JSON.parse( items.find( i => i.topic.endsWith( "/watering" ) )!.payload ).scale ).to.equal( 80 );
	} );

	it( "omits the budget topic when budget is absent, includes it when present", () => {
		expect( buildStatePayloads( "osw", "p", base as any ).some( i => i.topic.endsWith( "/budget" ) ) ).to.equal( false );
		const withBudget = buildStatePayloads( "osw", "p", { ...base, budget: { rainBank: 0.5 } } as any );
		expect( withBudget.some( i => i.topic.endsWith( "/budget" ) ) ).to.equal( true );
	} );
} );

describe( "buildDiscoveryConfigs", () => {
	it( "emits one retained discovery config per entity with shared device + availability", () => {
		const items = buildDiscoveryConfigs( "osw", "osw-weather", "homeassistant" );
		expect( items.length ).to.be.greaterThan( 5 );
		const scale = items.find( i => i.topic === "homeassistant/sensor/osw_watering_scale/config" )!;
		expect( scale ).to.be.an( "object" );
		const cfg = JSON.parse( scale.payload );
		expect( cfg.unique_id ).to.equal( "osw_watering_scale" );
		expect( cfg.state_topic ).to.equal( "osw-weather/osw/watering" );
		expect( cfg.availability_topic ).to.equal( "osw-weather/osw/availability" );
		expect( cfg.value_template ).to.contain( "value_json.scale" );
		expect( cfg.device.identifiers ).to.eql( [ "osw" ] );
		expect( scale.retain ).to.equal( true );
	} );

	it( "models watering_skip as a binary_sensor with ON/OFF", () => {
		const items = buildDiscoveryConfigs( "osw", "p", "homeassistant" );
		const skip = items.find( i => i.topic === "homeassistant/binary_sensor/osw_watering_skip/config" )!;
		expect( skip ).to.be.an( "object" );
		const cfg = JSON.parse( skip.payload );
		expect( cfg.payload_on ).to.equal( "ON" );
		expect( cfg.payload_off ).to.equal( "OFF" );
	} );
} );
