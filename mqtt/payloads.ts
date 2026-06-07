export interface StatusInfo { ok: boolean; errorCode?: number; lastError?: string; }
export interface GatheredState { watering?: any; weather?: any; budget?: any; status: StatusInfo; }
export interface PublishItem { topic: string; payload: string; retain: boolean; }

export function stateTopics( deviceId: string, prefix: string ) {
	const base = `${ prefix }/${ deviceId }`;
	return {
		availability: `${ base }/availability`,
		watering: `${ base }/watering`,
		weather: `${ base }/weather`,
		budget: `${ base }/budget`,
		status: `${ base }/status`
	};
}

export function buildStatePayloads( deviceId: string, prefix: string, state: GatheredState ): PublishItem[] {
	const t = stateTopics( deviceId, prefix );
	const items: PublishItem[] = [];
	if ( state.watering ) items.push( { topic: t.watering, payload: JSON.stringify( state.watering ), retain: true } );
	if ( state.weather ) items.push( { topic: t.weather, payload: JSON.stringify( state.weather ), retain: true } );
	if ( state.budget ) items.push( { topic: t.budget, payload: JSON.stringify( state.budget ), retain: true } );
	items.push( { topic: t.status, payload: JSON.stringify( state.status ), retain: true } );
	return items;
}

interface EntityDef {
	key: string; component: "sensor" | "binary_sensor"; name: string;
	stateTopic: "watering" | "weather" | "budget"; value_template: string;
	unit?: string; device_class?: string; state_class?: string;
	payload_on?: string; payload_off?: string;
}

const ENTITIES: EntityDef[] = [
	{ key: "watering_scale", component: "sensor", name: "Watering Scale", stateTopic: "watering", value_template: "{{ value_json.scale }}", unit: "%", state_class: "measurement" },
	{ key: "rain_delay", component: "sensor", name: "Rain Delay", stateTopic: "watering", value_template: "{{ value_json.rainDelay }}", unit: "h" },
	{ key: "watering_skip", component: "binary_sensor", name: "Watering Skip", stateTopic: "watering", value_template: "{{ 'ON' if value_json.skip else 'OFF' }}", payload_on: "ON", payload_off: "OFF" },
	{ key: "watering_reason", component: "sensor", name: "Watering Reason", stateTopic: "watering", value_template: "{{ value_json.reason }}" },
	{ key: "weather_provider", component: "sensor", name: "Weather Provider", stateTopic: "watering", value_template: "{{ value_json.weatherProvider }}" },
	{ key: "temperature", component: "sensor", name: "Temperature", stateTopic: "weather", value_template: "{{ value_json.temp }}", unit: "°F", device_class: "temperature", state_class: "measurement" },
	{ key: "humidity", component: "sensor", name: "Humidity", stateTopic: "weather", value_template: "{{ value_json.humidity }}", unit: "%", device_class: "humidity", state_class: "measurement" },
	{ key: "wind", component: "sensor", name: "Wind", stateTopic: "weather", value_template: "{{ value_json.wind }}", unit: "mph", device_class: "wind_speed" },
	{ key: "precip", component: "sensor", name: "Precipitation", stateTopic: "weather", value_template: "{{ value_json.precip }}", unit: "in", device_class: "precipitation" },
	{ key: "rain_bank", component: "sensor", name: "Rain Bank", stateTopic: "budget", value_template: "{{ value_json.rainBank | default('') }}", unit: "in" }
];

export function buildDiscoveryConfigs( deviceId: string, prefix: string, discoveryPrefix: string ): PublishItem[] {
	const t = stateTopics( deviceId, prefix );
	const device = { identifiers: [ deviceId ], name: `OpenSprinkler Weather (${ deviceId })`, manufacturer: "OpenSprinkler-Weather" };
	return ENTITIES.map( ( e ): PublishItem => {
		const cfg: any = {
			name: e.name,
			unique_id: `${ deviceId }_${ e.key }`,
			state_topic: ( t as any )[ e.stateTopic ],
			value_template: e.value_template,
			availability_topic: t.availability,
			payload_available: "online",
			payload_not_available: "offline",
			device
		};
		if ( e.unit ) cfg.unit_of_measurement = e.unit;
		if ( e.device_class ) cfg.device_class = e.device_class;
		if ( e.state_class ) cfg.state_class = e.state_class;
		if ( e.payload_on ) { cfg.payload_on = e.payload_on; cfg.payload_off = e.payload_off; }
		return { topic: `${ discoveryPrefix }/${ e.component }/${ deviceId }_${ e.key }/config`, payload: JSON.stringify( cfg ), retain: true };
	} );
}
