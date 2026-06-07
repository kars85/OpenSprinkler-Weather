import { expect } from "chai";
import { resolveMqttConfig } from "./config";

describe( "resolveMqttConfig", () => {
	it( "returns null when MQTT_BROKER_URL is unset", () => {
		expect( resolveMqttConfig( {} ) ).to.equal( null );
	} );

	it( "returns null (idle) when broker set but MQTT_LOCATION missing", () => {
		expect( resolveMqttConfig( { MQTT_BROKER_URL: "mqtt://h:1883" } ) ).to.equal( null );
	} );

	it( "parses defaults", () => {
		const c = resolveMqttConfig( { MQTT_BROKER_URL: "mqtt://h:1883", MQTT_LOCATION: "1,2" } )!;
		expect( c.topicPrefix ).to.equal( "opensprinkler-weather" );
		expect( c.discoveryPrefix ).to.equal( "homeassistant" );
		expect( c.deviceId ).to.equal( "osw" );
		expect( c.intervalMs ).to.equal( 30 * 60000 );
		expect( c.adjustmentParam ).to.equal( 4 ); // default method 4, no restrict
	} );

	it( "applies MQTT_RESTRICT to the adjustment param", () => {
		const c = resolveMqttConfig( { MQTT_BROKER_URL: "mqtt://h", MQTT_LOCATION: "1,2", MQTT_METHOD: "1", MQTT_RESTRICT: "1" } )!;
		expect( c.adjustmentParam ).to.equal( 1 | ( 1 << 7 ) );
	} );

	it( "rejects wildcard / empty prefixes and bad device ids (returns null)", () => {
		const base = { MQTT_BROKER_URL: "mqtt://h", MQTT_LOCATION: "1,2" };
		expect( resolveMqttConfig( { ...base, MQTT_TOPIC_PREFIX: "a/#" } ) ).to.equal( null );
		expect( resolveMqttConfig( { ...base, MQTT_DISCOVERY_PREFIX: "a+b" } ) ).to.equal( null );
		expect( resolveMqttConfig( { ...base, MQTT_DEVICE_ID: "bad/id" } ) ).to.equal( null );
		expect( resolveMqttConfig( { ...base, MQTT_DEVICE_ID: "" } ) ).to.equal( null );
	} );
} );
