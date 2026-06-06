export interface MqttConfig {
	brokerUrl: string;
	username?: string;
	password?: string;
	location: string;
	adjustmentParam: number;
	provider?: string;
	pws?: string;
	key?: string;
	topicPrefix: string;
	discoveryPrefix: string;
	deviceId: string;
	intervalMs: number;
}

const WILDCARDS = /[+#]/;

function trimmed( v: string | undefined, def: string ): string {
	const s = ( v === undefined || v === null ) ? "" : String( v ).trim();
	return s === "" ? def : s;
}

function parseBool( v: string | undefined ): boolean {
	if ( v === undefined || v === null ) return false;
	return [ "true", "1", "yes", "on" ].indexOf( String( v ).trim().toLowerCase() ) !== -1;
}

/** Resolve MQTT config from env, or null when disabled / invalid (a clear warning is logged). */
export function resolveMqttConfig( env: { [ k: string ]: string | undefined } = process.env as any ): MqttConfig | null {
	const brokerUrl = trimmed( env.MQTT_BROKER_URL, "" );
	if ( !brokerUrl ) return null;

	const location = trimmed( env.MQTT_LOCATION, "" );
	if ( !location ) { console.warn( "MQTT_BROKER_URL is set but MQTT_LOCATION is missing; MQTT publisher is idle." ); return null; }

	const topicPrefix = trimmed( env.MQTT_TOPIC_PREFIX, "opensprinkler-weather" );
	const discoveryPrefix = trimmed( env.MQTT_DISCOVERY_PREFIX, "homeassistant" );
	const deviceId = trimmed( env.MQTT_DEVICE_ID, "osw" );
	if ( env.MQTT_DEVICE_ID !== undefined && String( env.MQTT_DEVICE_ID ).trim() === "" ) {
		console.warn( "MQTT_DEVICE_ID must match [a-zA-Z0-9_-]; MQTT publisher is idle." ); return null;
	}
	if ( WILDCARDS.test( topicPrefix ) || WILDCARDS.test( discoveryPrefix ) ) {
		console.warn( "MQTT topic/discovery prefix contains an MQTT wildcard (+/#); MQTT publisher is idle." ); return null;
	}
	if ( !/^[a-zA-Z0-9_-]+$/.test( deviceId ) ) {
		console.warn( "MQTT_DEVICE_ID must match [a-zA-Z0-9_-]; MQTT publisher is idle." ); return null;
	}

	let method = parseInt( trimmed( env.MQTT_METHOD, "4" ), 10 );
	if ( isNaN( method ) || method < 0 || method > 4 ) method = 4;
	const adjustmentParam = method | ( parseBool( env.MQTT_RESTRICT ) ? ( 1 << 7 ) : 0 );

	let intervalMin = parseInt( trimmed( env.MQTT_INTERVAL_MINUTES, "30" ), 10 );
	if ( isNaN( intervalMin ) || intervalMin <= 0 ) intervalMin = 30;

	return {
		brokerUrl,
		username: trimmed( env.MQTT_USERNAME, "" ) || undefined,
		password: env.MQTT_PASSWORD || undefined,
		location,
		adjustmentParam,
		provider: trimmed( env.MQTT_PROVIDER, "" ) || undefined,
		pws: trimmed( env.MQTT_PWS, "" ) || undefined,
		key: env.MQTT_KEY || undefined,
		topicPrefix,
		discoveryPrefix,
		deviceId,
		intervalMs: intervalMin * 60000
	};
}
