# MQTT Publisher (+ HA Discovery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in background MQTT publisher that periodically pushes the configured site's watering/weather/budget to retained MQTT topics with Home Assistant discovery, reusing the `/v1` compute/read layer — with zero runtime change when disabled.

**Architecture:** Pure modules (`mqtt/config.ts`, `mqtt/payloads.ts`, and a pure `gatherState`) plus a small I/O publisher (`mqtt/MqttPublisher.ts`) with an injectable MQTT client and injectable data-fetchers, so everything is unit-testable without a broker or network. Shapers are extracted to a pure `routes/api/shapers.ts` (shared by `/v1` and MQTT). Started from `server.ts` only when `MQTT_BROKER_URL` is set.

**Tech Stack:** TypeScript (es5/commonjs), Express, mocha + chai (existing); new `mqtt` npm dependency.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `routes/api/shapers.ts` | Pure `shapeWateringResponse`/`shapeWeatherResponse`/`shapeBudgetResponse` (moved from `routes/v1/index.ts`). | Create |
| `routes/v1/index.ts` | Import shapers from `../api/shapers` (no behavior change). | Modify |
| `mqtt/config.ts` | `resolveMqttConfig(env)` + validation. Pure. | Create |
| `mqtt/payloads.ts` | `buildStatePayloads`, `buildDiscoveryConfigs`, topic helpers. Pure. | Create |
| `mqtt/MqttPublisher.ts` | `gatherState` (injectable deps), `createPublisher` (injectable client/gather), `startMqttPublisher` (real wiring). | Create |
| `mqtt/config.spec.ts`, `mqtt/payloads.spec.ts`, `mqtt/MqttPublisher.spec.ts` | Unit tests (pure + fake client). | Create |
| `server.ts` | Guarded `startMqttPublisher()` when `MQTT_BROKER_URL` set. | Modify |
| `package.json` / `package-lock.json` | Add `mqtt`. | Modify |
| `docs/mqtt.md` + `README.md` | Operator + HA guide. | Create/Modify |

**Test commands:** subset → `npm test -- --grep "<name>"`; full → `npm test`; type-check → `npm run compile`.

> **Empirica note (this session only):** the sentinel firewall gates praxic commands. If a `git`/`npm`/Edit call is denied with `Epistemic loop closed` / `Run new PREFLIGHT`, open a transaction first: `empirica preflight-submit -` then `empirica check-submit -` (JSON on stdin via heredoc with a `vectors` object; `check-submit` also needs `phase:"praxic"`). Close later with `empirica postflight-submit -`. A normal worker without the sentinel can ignore this.

---

## Task 1: Extract shapers to a pure module

**Files:**
- Create: `routes/api/shapers.ts`
- Modify: `routes/v1/index.ts`
- Test: existing `routes/v1/v1.spec.ts` is the guard (behavior unchanged)

- [ ] **Step 1: Create the pure shapers module.** Create `routes/api/shapers.ts` with the three functions currently in `routes/v1/index.ts` (verbatim bodies):

```typescript
import { GeoCoordinates } from "../../types";
import { WateringDecision } from "../weather";

export function shapeWateringResponse( d: WateringDecision ): any {
	const raw = d.rawData || {};
	return {
		location: d.coordinates,
		method: d.methodName,
		methodName: d.methodName,
		methodId: d.methodId,
		scale: d.scale,
		rainDelay: d.rainDelay,
		skip: d.skip,
		skipReason: d.skipReason !== undefined ? d.skipReason : null,
		pwsBypassed: d.pwsBypassed,
		weatherProvider: d.weatherProvider,
		reason: raw.reason !== undefined ? raw.reason : null,
		raw: d.rawData
	};
}

export function shapeWeatherResponse( coordinates: GeoCoordinates, weather: any ): any {
	return {
		location: coordinates,
		weatherProvider: weather.weatherProvider,
		temp: weather.temp,
		humidity: weather.humidity,
		wind: weather.wind,
		precip: weather.precip,
		minTemp: weather.minTemp,
		maxTemp: weather.maxTemp,
		description: weather.description,
		icon: weather.icon
	};
}

export function shapeBudgetResponse( coordinates: GeoCoordinates, state: any, limit: number ): any {
	const history = ( state.history || [] ).slice( -limit ).map( ( r: any ) => {
		const out: any = {
			date: r.date, scale: r.scale, eto: r.eto, etc: r.etc,
			effectiveRain: r.effectiveRain, rainBankAfter: r.rainBankAfter, reason: r.reason
		};
		if ( r.kcSource !== undefined ) { out.kc = r.demandKc; out.kcSource = r.kcSource; }
		return out;
	} );
	return {
		location: coordinates,
		rainBank: state.rainBank,
		lastUpdated: state.lastUpdated,
		lastScale: state.lastScale,
		history
	};
}
```

- [ ] **Step 2: Update `routes/v1/index.ts` to import them.** Remove the three `function shapeWateringResponse/shapeWeatherResponse/shapeBudgetResponse` definitions from `routes/v1/index.ts`, and add near the top (after the existing imports):

```typescript
import { shapeBudgetResponse, shapeWateringResponse, shapeWeatherResponse } from "../api/shapers";
```

(Keep the `BUDGET_HISTORY_CAP`/`BUDGET_HISTORY_DEFAULT` constants and all handlers in `routes/v1/index.ts` — only the three shaper functions move.)

- [ ] **Step 3: Run the /v1 suite + full suite (behavior unchanged).**

Run: `npm test -- --grep "/v1/"` → PASS (the move is behavior-preserving).
Run: `npm test` → all pass. Run `npm run compile` → clean.

- [ ] **Step 4: Commit.**

```bash
git add routes/api/shapers.ts routes/v1/index.ts
git commit -m "refactor(mqtt): extract /v1 shapers to pure routes/api/shapers.ts [#mqtt]"
```

---

## Task 2: `mqtt/config.ts`

**Files:**
- Create: `mqtt/config.ts`
- Test: `mqtt/config.spec.ts`

- [ ] **Step 1: Write the failing tests.** Create `mqtt/config.spec.ts`:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "resolveMqttConfig"`
Expected: FAIL — `Cannot find module './config'`.

- [ ] **Step 3: Write the implementation.** Create `mqtt/config.ts`:

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npm test -- --grep "resolveMqttConfig"` → PASS. Run `npm run compile` → clean.

- [ ] **Step 5: Commit.**

```bash
git add mqtt/config.ts mqtt/config.spec.ts
git commit -m "feat(mqtt): resolveMqttConfig with validation [#mqtt]"
```

---

## Task 3: `mqtt/payloads.ts` (pure builders)

**Files:**
- Create: `mqtt/payloads.ts`
- Test: `mqtt/payloads.spec.ts`

- [ ] **Step 1: Write the failing tests.** Create `mqtt/payloads.spec.ts`:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "buildStatePayloads|buildDiscoveryConfigs"`
Expected: FAIL — `Cannot find module './payloads'`.

- [ ] **Step 3: Write the implementation.** Create `mqtt/payloads.ts`:

```typescript
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
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `npm test -- --grep "buildStatePayloads|buildDiscoveryConfigs"` → PASS. Run `npm run compile` → clean.

- [ ] **Step 5: Commit.**

```bash
git add mqtt/payloads.ts mqtt/payloads.spec.ts
git commit -m "feat(mqtt): pure state + HA discovery payload builders [#mqtt]"
```

---

## Task 4: `mqtt/MqttPublisher.ts` (gather + publisher core + wiring)

**Files:**
- Create: `mqtt/MqttPublisher.ts`
- Test: `mqtt/MqttPublisher.spec.ts`
- Modify: `package.json` (add `mqtt`)

- [ ] **Step 1: Add the `mqtt` dependency.**

Run: `npm install mqtt`
Expected: `package.json`/`package-lock.json` updated; `node_modules/mqtt` present.

- [ ] **Step 2: Write the failing tests.** Create `mqtt/MqttPublisher.spec.ts`:

```typescript
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
```

- [ ] **Step 3: Run the tests to verify they fail.**

Run: `npm test -- --grep "gatherState|createPublisher"`
Expected: FAIL — `Cannot find module './MqttPublisher'`.

- [ ] **Step 4: Write the implementation.** Create `mqtt/MqttPublisher.ts`:

```typescript
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
```

  Note: `debugLog` and `redactLogValue` are already exported from `routes/weather.ts`; `resolveWeatherProvider`, `computeWateringDecision`, `buildPwsFromParams`, `resolveCoordinates`, `WateringDecision` were exported in the `/v1` work.

- [ ] **Step 5: Run the tests + full suite.**

Run: `npm test -- --grep "gatherState|createPublisher"` → PASS.
Run: `npm test` → all pass. Run `npm run compile` → clean.

- [ ] **Step 6: Commit.**

```bash
git add mqtt/MqttPublisher.ts mqtt/MqttPublisher.spec.ts package.json package-lock.json
git commit -m "feat(mqtt): publisher core + gatherState (injectable, broker-free tests) [#mqtt]"
```

---

## Task 5: Start the publisher from `server.ts`

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Add the guarded start.** In `server.ts`, inside the `app.listen(...)` callback (after the existing startup logs), add:

```typescript
		if ( process.env.MQTT_BROKER_URL ) {
			require( "./mqtt/MqttPublisher" ).startMqttPublisher();
		}
```

  This guards the `require` so the `mqtt` module is only loaded when enabled (no runtime change when unset).

- [ ] **Step 2: Verify the build + suite.**

Run: `npm run compile` → clean.
Run: `npm test` → all pass (the existing suites import from `./routes/...`, not `server.ts`, so behavior is unchanged).

- [ ] **Step 3: Commit.**

```bash
git add server.ts
git commit -m "feat(mqtt): start the MQTT publisher when MQTT_BROKER_URL is set [#mqtt]"
```

---

## Task 6: Documentation

**Files:**
- Create: `docs/mqtt.md`
- Modify: `README.md`

- [ ] **Step 1: Write the docs.** Create `docs/mqtt.md`:

```markdown
# MQTT Publishing (+ Home Assistant)

When `MQTT_BROKER_URL` is set, the service connects to your MQTT broker and periodically
publishes your site's watering decision, weather, and Water-Budget state as **retained**
topics, and emits **Home Assistant MQTT discovery** so HA auto-creates entities. It is
**off by default** — nothing connects until you configure a broker.

## Configuration (environment variables)

| Var | Default | Meaning |
|---|---|---|
| `MQTT_BROKER_URL` | — | Enables publishing, e.g. `mqtt://192.168.1.10:1883`. |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | — | Optional broker auth. |
| `MQTT_LOCATION` | — | Your site location (`lat,lon` or a geocodable string). Required. |
| `MQTT_METHOD` | 4 | Adjustment method (0 manual, 1 zimmerman, 2 rainDelay, 3 eto, 4 waterBudget). |
| `MQTT_RESTRICT` | 0 | `1` applies the rain restriction. |
| `MQTT_PROVIDER` / `MQTT_PWS` / `MQTT_KEY` | — | Optional provider / personal weather station. |
| `MQTT_TOPIC_PREFIX` | `opensprinkler-weather` | State/availability/status topic prefix. |
| `MQTT_DISCOVERY_PREFIX` | `homeassistant` | HA discovery prefix. |
| `MQTT_DEVICE_ID` | `osw` | Device id (`[A-Za-z0-9_-]`). |
| `MQTT_INTERVAL_MINUTES` | 30 | Publish interval. |

## Topics

- `<prefix>/<deviceId>/availability` — `online`/`offline` (retained; LWT).
- `<prefix>/<deviceId>/watering` — watering decision JSON (retained).
- `<prefix>/<deviceId>/weather` — current conditions JSON (retained).
- `<prefix>/<deviceId>/budget` — Water-Budget JSON (retained; only once budget state exists).
- `<prefix>/<deviceId>/status` — `{ ok, errorCode?, lastError? }` diagnostics (retained).

## Home Assistant

With discovery enabled (default), HA auto-creates sensors (watering scale, rain delay,
weather, rain bank, etc.) and a binary sensor for "watering skip", all under one device.
No manual sensor config needed — just point the service at the same broker HA uses.

## Notes

- Watering follows the same daily cache as the HTTP API; weather is fetched fresh each interval.
- A weather/compute failure for one section leaves that topic's last retained value intact and
  sets `status.ok=false`; the broker availability stays `online` (it reflects only the connection).
- Credentials and API keys are never published or included in discovery, and are redacted in logs.
```

  Add to `README.md` near the other docs links:

```markdown
- For **MQTT publishing + Home Assistant** (push watering/weather/budget to your broker), see [here](docs/mqtt.md)
```

- [ ] **Step 2: Verify + commit.**

Run: `npm run compile` (clean) and confirm both files staged.

```bash
git add docs/mqtt.md README.md
git commit -m "docs(mqtt): MQTT + Home Assistant setup guide [#mqtt]"
```

---

## Done criteria

- `npm test` green (existing suites unchanged + new `resolveMqttConfig`, `buildStatePayloads`/`buildDiscoveryConfigs`, `gatherState`, `createPublisher` tests), `npm run compile` clean.
- With `MQTT_BROKER_URL` unset, there is **no runtime change** — the `mqtt` module is never loaded and no connection is attempted.
- With it set + `MQTT_LOCATION`, the publisher connects (LWT `offline` retained), publishes `online` + HA discovery on connect, and publishes retained state + status every interval; a per-section failure omits only that topic and flags `status.ok=false` without flipping availability.
- The `/v1` suite still passes after the shaper move (shapers are shared, not duplicated).

## Out of scope (per spec)
- Command/control (MQTT subscribe), multiple sites, non-HA discovery, TLS client certs.
- Any change to `/v1` HTTP behavior, the compute/read layer, or legacy responses.
