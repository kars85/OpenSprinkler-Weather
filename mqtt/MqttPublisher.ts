import { GeoCoordinates, PWS } from "../types";
import { AdjustmentOptions } from "../routes/adjustmentMethods/AdjustmentMethod";
import {
	buildPwsFromParams, computeWateringDecision, debugLog, redactLogValue,
	resolveCoordinates, resolveWeatherProvider, WateringDecision
} from "../routes/weather";
import { getBudgetState } from "../routes/adjustmentMethods/WaterBudgetAdjustmentMethod";
import { shapeBudgetResponse, shapeWateringResponse, shapeWeatherResponse } from "../routes/api/shapers";
import { makeCodedError } from "../errors";
import { MqttConfig, resolveMqttConfig } from "./config";
import { buildDiscoveryConfigs, buildStatePayloads, GatheredState, PublishItem, stateTopics } from "./payloads";

const BUDGET_HISTORY = 30;

/** Injectable data-fetchers so gatherState is testable without network. */
export interface GatherDeps {
	resolveCoordinates: ( loc: string ) => Promise< GeoCoordinates >;
	buildPwsFromParams: ( o: AdjustmentOptions ) => PWS | undefined;
	computeWateringDecision: ( input: any ) => Promise< WateringDecision >;
	resolveWeatherProvider: ( o: AdjustmentOptions, pws: PWS | undefined ) => { getWeatherData: ( c: GeoCoordinates, pws?: PWS ) => Promise< any > };
	getBudgetState: ( c: GeoCoordinates ) => Promise< any | undefined >;
}

const realDeps: GatherDeps = {
	resolveCoordinates, buildPwsFromParams, computeWateringDecision,
	resolveWeatherProvider: ( o, pws ) => resolveWeatherProvider( o, pws ),
	getBudgetState
};

/** Gather the three state sections independently; a failure in one never blocks the others. */
export async function gatherState( config: MqttConfig, deps: GatherDeps = realDeps ): Promise< GatheredState > {
	const status: { ok: boolean; errorCode?: number; lastError?: string } = { ok: true };
	const fail = ( err: any ) => { const c = makeCodedError( err ); status.ok = false; status.errorCode = c.errCode; status.lastError = String( c.message || "" ).slice( 0, 200 ); };

	let coordinates: GeoCoordinates;
	const adjustmentOptions: AdjustmentOptions = { provider: config.provider, pws: config.pws, key: config.key };
	let pws: PWS | undefined;
	try {
		coordinates = await deps.resolveCoordinates( config.location );
		pws = deps.buildPwsFromParams( adjustmentOptions );
	} catch ( err ) {
		fail( err );
		return { status };
	}

	const out: GatheredState = { status };
	try {
		const decision = await deps.computeWateringDecision( { coordinates, adjustmentParam: config.adjustmentParam, adjustmentOptions, pws } );
		out.watering = shapeWateringResponse( decision );
	} catch ( err ) { fail( err ); }

	try {
		const provider = deps.resolveWeatherProvider( adjustmentOptions, pws );
		out.weather = shapeWeatherResponse( coordinates, await provider.getWeatherData( coordinates, pws ) );
	} catch ( err ) { fail( err ); }

	try {
		const st = await deps.getBudgetState( coordinates );
		if ( st ) out.budget = shapeBudgetResponse( coordinates, st, BUDGET_HISTORY );
	} catch ( err ) { fail( err ); }

	return out;
}

export interface MqttClientLike {
	publish( topic: string, payload: string, opts: any, cb?: ( err?: any ) => void ): void;
	on( event: string, handler: ( ...args: any[] ) => void ): void;
	end?: ( ...args: any[] ) => void;
}

/** Publisher core: testable with an injected client + gather function. */
export function createPublisher( config: MqttConfig, client: MqttClientLike, gather: () => Promise< GatheredState > ) {
	const t = stateTopics( config.deviceId, config.topicPrefix );
	let inFlight = false;

	function publishItems( items: PublishItem[] ): void {
		for ( const item of items ) {
			client.publish( item.topic, item.payload, { retain: item.retain, qos: 0 }, ( err?: any ) => {
				if ( err ) console.error( "MQTT publish failed for", item.topic, redactLogValue( err ) );
			} );
		}
	}

	async function tick(): Promise< void > {
		if ( inFlight ) { debugLog( "MQTT: skipping overlapping tick" ); return; }
		inFlight = true;
		try {
			const state = await gather();
			publishItems( buildStatePayloads( config.deviceId, config.topicPrefix, state ) );
		} catch ( err ) {
			console.error( "MQTT tick failed:", redactLogValue( err ) );
		} finally {
			inFlight = false;
		}
	}

	async function onConnect(): Promise< void > {
		client.publish( t.availability, "online", { retain: true, qos: 0 } );
		publishItems( buildDiscoveryConfigs( config.deviceId, config.topicPrefix, config.discoveryPrefix ) );
		await tick();
	}

	return { tick, onConnect };
}

/** Real wiring: connect to the broker (LWT) and run the interval loop. Called only when enabled. */
export function startMqttPublisher( env: { [ k: string ]: string | undefined } = process.env as any ): void {
	const config = resolveMqttConfig( env );
	if ( !config ) return;
	const mqtt = require( "mqtt" );
	const t = stateTopics( config.deviceId, config.topicPrefix );
	const client: MqttClientLike = mqtt.connect( config.brokerUrl, {
		username: config.username,
		password: config.password,
		will: { topic: t.availability, payload: "offline", retain: true, qos: 0 }
	} );
	const pub = createPublisher( config, client, () => gatherState( config ) );
	client.on( "connect", () => { pub.onConnect().catch( ( err ) => console.error( "MQTT onConnect failed:", redactLogValue( err ) ) ); } );
	client.on( "error", ( err: any ) => console.error( "MQTT client error:", redactLogValue( err ) ) );
	setInterval( () => { pub.tick().catch( ( err ) => console.error( "MQTT tick failed:", redactLogValue( err ) ) ); }, config.intervalMs );
	console.log( `MQTT publisher started for ${ config.location } -> ${ config.topicPrefix }/${ config.deviceId } every ${ config.intervalMs / 60000 }min` );
}
