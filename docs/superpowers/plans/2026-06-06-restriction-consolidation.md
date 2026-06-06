# Rain-Restriction Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the two precip→`scale 0` rules into one — make the firmware restriction bit (bit 7 / `/v1` `restrict`) a `forceRain` alias for the weather-skips rain rule, and remove `checkWeatherRestriction`.

**Architecture:** Add a `forceRain` flag to `resolveSkipConfig` (fills a missing rain rule) and thread it through `applyWeatherSkips`; in `computeWateringDecision`, delete the `checkWeatherRestriction` step and pass `forceRain = checkRestrictions` to the skip overlay. One rain decision path; the restriction becomes live-over-cache and fail-open.

**Tech Stack:** TypeScript (es5/commonjs), Express, mocha + chai + nock + mock-express (existing).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `routes/skips/WeatherSkips.ts` | `resolveSkipConfig` gains `forceRain` (fills missing rain). | Modify |
| `routes/skips/SkipGuard.ts` | `applyWeatherSkips` gains trailing `forceRain`, threaded to `resolveSkipConfig`. | Modify |
| `routes/weather.ts` | `computeWateringDecision`: remove `checkWeatherRestriction` block + restriction-fetch; pass `forceRain`; delete `checkWeatherRestriction` + export. | Modify |
| `routes/skips/WeatherSkips.spec.ts`, `routes/skips/SkipGuard.spec.ts`, `routes/weather.spec.ts` | force-rain + unified-path + cache-hit-liveness tests. | Modify (append) |
| `docs/weather-skips.md`, `docs/v1-api.md`, `docs/mqtt.md`, `README.md` | Restriction bit = rain skip alias; document behavior. | Modify |

**Test commands:** subset → `npm test -- --grep "<name>"`; full → `npm test`; type-check → `npm run compile`.

> **Empirica note (this session only):** the sentinel firewall gates praxic commands. If a `git`/`npm`/Edit call is denied with `Epistemic loop closed` / `Run new PREFLIGHT`, open a transaction first: `empirica preflight-submit -` then `empirica check-submit -` (JSON on stdin via heredoc with a `vectors` object; `check-submit` also needs `phase:"praxic"`). Close later with `empirica postflight-submit -`. A normal worker without the sentinel can ignore this.

---

## Task 1: `forceRain` in `resolveSkipConfig`

**Files:**
- Modify: `routes/skips/WeatherSkips.ts`
- Test: `routes/skips/WeatherSkips.spec.ts` (append)

- [ ] **Step 1: Write the failing tests.** Append to `routes/skips/WeatherSkips.spec.ts` (it already imports `resolveSkipConfig`):

```typescript
describe( "WeatherSkips.resolveSkipConfig forceRain", () => {
	it( "force-enables rain when no rain config is present (threshold env/wto/default)", () => {
		expect( resolveSkipConfig( {}, {}, true ) ).to.deep.equal( { rain: { threshold: 0.1 } } );
		expect( resolveSkipConfig( {}, { RAIN_SKIP: "0.25" }, true ) ).to.deep.equal( { rain: { threshold: 0.25 } } );
		expect( resolveSkipConfig( { skipRainThreshold: 0.3 }, { RAIN_SKIP: "0.25" }, true ) ).to.deep.equal( { rain: { threshold: 0.3 } } );
	} );

	it( "force-enables rain even when skipRain is explicitly off", () => {
		expect( resolveSkipConfig( {}, { SKIP_RAIN: "false" }, true ) ).to.deep.equal( { rain: { threshold: 0.1 } } );
	} );

	it( "does not override an already-enabled rain config", () => {
		expect( resolveSkipConfig( { skipRain: "on", skipRainThreshold: 0.5 }, {}, true ) ).to.deep.equal( { rain: { threshold: 0.5 } } );
	} );

	it( "forceRain defaults to false (adds no rain rule)", () => {
		expect( resolveSkipConfig( {}, {} ) ).to.deep.equal( {} );
	} );
} );
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "resolveSkipConfig forceRain"`
Expected: FAIL — `resolveSkipConfig` ignores the 3rd argument, so `resolveSkipConfig({}, {}, true)` returns `{}`.

- [ ] **Step 3: Implement.** In `routes/skips/WeatherSkips.ts`, change the `resolveSkipConfig` signature and add the force line after the rain rule. Replace:

```typescript
export function resolveSkipConfig(
	adjustmentOptions: { [ k: string ]: any },
	env: { [ k: string ]: string | undefined } = process.env as any
): SkipConfig {
```

with:

```typescript
export function resolveSkipConfig(
	adjustmentOptions: { [ k: string ]: any },
	env: { [ k: string ]: string | undefined } = process.env as any,
	forceRain: boolean = false
): SkipConfig {
```

and, immediately after the existing `if ( enabled( "skipRain", "SKIP_RAIN" ) ) cfg.rain = { ... };` line and before `return cfg;`, add:

```typescript
	if ( forceRain && !cfg.rain ) cfg.rain = { threshold: value( "skipRainThreshold", "RAIN_SKIP", 0.1 ) };
```

- [ ] **Step 4: Run the tests + full suite.**

Run: `npm test -- --grep "resolveSkipConfig"` → PASS. Run `npm test` → all pass. `npm run compile` → clean.

- [ ] **Step 5: Commit.**

```bash
git add routes/skips/WeatherSkips.ts routes/skips/WeatherSkips.spec.ts
git commit -m "feat(restrict): forceRain fills a missing rain rule in resolveSkipConfig [#restrict]"
```

---

## Task 2: `forceRain` in `applyWeatherSkips`

**Files:**
- Modify: `routes/skips/SkipGuard.ts`
- Test: `routes/skips/SkipGuard.spec.ts` (append)

- [ ] **Step 1: Write the failing tests.** Append to `routes/skips/SkipGuard.spec.ts` (it already has `StubProvider`, `coords`, `applyWeatherSkips`, `__clearSkipWeatherMemo`):

```typescript
describe( "SkipGuard.applyWeatherSkips forceRain", () => {
	beforeEach( () => __clearSkipWeatherMemo() );
	const base = { scale: 80, rawData: { wp: "OWM" } };

	it( "forces a rain skip on a wet day even when SKIP_RAIN is unset", async () => {
		const p = new StubProvider( { precip: 0.5, minTemp: 60, temp: 65, wind: 3 } );
		const out = await applyWeatherSkips( base, p, coords, undefined, {} as any, 1000, true );
		expect( out.scale ).to.equal( 0 );
		expect( out.rawData.skip ).to.equal( 1 );
		expect( out.rawData.skipReason ).to.contain( "rain" );
	} );

	it( "no-ops on a dry day under forceRain", async () => {
		const p = new StubProvider( { precip: 0, minTemp: 60, temp: 65, wind: 3 } );
		const out = await applyWeatherSkips( base, p, coords, undefined, {} as any, 1000, true );
		expect( out ).to.equal( base );
	} );

	it( "fails open under forceRain when weather is unavailable", async () => {
		const p = new StubProvider( null, true );
		const out = await applyWeatherSkips( base, p, coords, undefined, {} as any, 1000, true );
		expect( out ).to.equal( base );
	} );
} );
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "applyWeatherSkips forceRain"`
Expected: FAIL — `applyWeatherSkips` ignores the 7th argument; with no `SKIP_RAIN` set, the wet day returns `base` unchanged.

- [ ] **Step 3: Implement.** In `routes/skips/SkipGuard.ts`, change the `applyWeatherSkips` signature and the `resolveSkipConfig` call. Replace:

```typescript
export async function applyWeatherSkips(
	dataToSend: any, weatherProvider: WeatherProvider, coordinates: GeoCoordinates,
	pws: PWS | undefined, adjustmentOptions: AdjustmentOptions, now: number = Date.now()
): Promise< any > {
	const cfg = resolveSkipConfig( adjustmentOptions || {} );
```

with:

```typescript
export async function applyWeatherSkips(
	dataToSend: any, weatherProvider: WeatherProvider, coordinates: GeoCoordinates,
	pws: PWS | undefined, adjustmentOptions: AdjustmentOptions, now: number = Date.now(),
	forceRain: boolean = false
): Promise< any > {
	const cfg = resolveSkipConfig( adjustmentOptions || {}, process.env as any, forceRain );
```

- [ ] **Step 4: Run the tests + full suite.**

Run: `npm test -- --grep "applyWeatherSkips forceRain"` → PASS. Run `npm test` → all pass. `npm run compile` → clean.

- [ ] **Step 5: Commit.**

```bash
git add routes/skips/SkipGuard.ts routes/skips/SkipGuard.spec.ts
git commit -m "feat(restrict): thread forceRain through applyWeatherSkips [#restrict]"
```

---

## Task 3: Unify in `computeWateringDecision`; remove `checkWeatherRestriction`

**Files:**
- Modify: `routes/weather.ts`
- Test: `routes/weather.spec.ts` (append)

- [ ] **Step 1: Write the failing tests.** Append to `routes/weather.spec.ts`, **inside** the `describe('Watering Data', ...)` block (so `MockDate`, `mockGeocoder`, `mockOWMWatering`, `mockOpenMeteoETo`, `createExpressMocks`, `location` are in scope):

```typescript
    it('restriction bit force-enables the rain skip (scale 0 + rain reason)', async () => {
        mockGeocoder();
        mockOWMWatering(); // method (Zimmerman) data
        // The skip overlay then calls OWM.getWeatherData -> a wet day.
        nock('https://api.openweathermap.org')
            .get('/data/3.0/onecall').query(true)
            .reply(200, {
                current: { temp: 60, humidity: 80, wind_speed: 3, weather: [ { id: 500, main: 'Rain', description: 'rain', icon: '10d' } ] },
                daily: [ { dt: 1557705600, temp: { min: 55, max: 70 }, rain: 0.5, weather: [ { id: 500, main: 'Rain', description: 'rain', icon: '10d' } ] } ]
            });
        const expressMocks = createExpressMocks(1 | (1 << 7), location, '"provider":"OWM"');
        await getWateringData(expressMocks.request, expressMocks.response);
        const body: any = expressMocks.response._getJSON();
        expect( body.scale ).to.equal( 0 );
        expect( body.rawData.skip ).to.equal( 1 );
        expect( body.rawData.skipReason ).to.be.a('string').and.contain('rain');
    });

    it('applies the rain restriction LIVE over a cached method result (not a cached 0)', async () => {
        const { __clearSkipWeatherMemo } = require('./skips/SkipGuard');
        const loc = '42.3732,-72.5199';
        const param = 4 | (1 << 7); // WaterBudget (caches) + restriction bit

        // Request 1: ETo (cached after) + WET skip-weather -> rain skip -> scale 0.
        mockOpenMeteoETo(); // getEToData (forecast hourly), once
        nock('https://api.open-meteo.com').get('/v1/forecast').query(true).once().reply(200, {
            current_weather: { temperature: 60, windspeed: 3, weathercode: 61 },
            daily: { time: [ 1557705600 ], temperature_2m_min: [ 55 ], temperature_2m_max: [ 70 ], precipitation_sum: [ 0.5 ], weathercode: [ 61 ] }
        });
        const a = createExpressMocks(param, loc, '"provider":"OpenMeteo"');
        await getWateringData(a.request, a.response);
        expect( a.response._getJSON().scale ).to.equal( 0 );
        expect( a.response._getJSON().rawData.skip ).to.equal( 1 );

        // Request 2: same day/coords -> method CACHE HIT (no ETo call). Fresh DRY skip-weather -> no skip.
        __clearSkipWeatherMemo();
        nock('https://api.open-meteo.com').get('/v1/forecast').query(true).once().reply(200, {
            current_weather: { temperature: 60, windspeed: 3, weathercode: 1 },
            daily: { time: [ 1557705600 ], temperature_2m_min: [ 55 ], temperature_2m_max: [ 70 ], precipitation_sum: [ 0 ], weathercode: [ 1 ] }
        });
        const b = createExpressMocks(param, loc, '"provider":"OpenMeteo"');
        await getWateringData(b.request, b.response);
        // The cached method result was NOT pre-restricted: a dry cache-hit applies no skip.
        expect( b.response._getJSON().rawData.skip ).to.equal( undefined );
    });
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `npm test -- --grep "force-enables the rain skip|LIVE over a cached"`
Expected: FAIL — the restriction bit currently runs `checkWeatherRestriction` (silent, no `rawData.skip`), so `body.rawData.skip` is `undefined` in the first test; and the cached restricted `0` makes the live test behave differently.

- [ ] **Step 3: Implement the unification.** In `routes/weather.ts`, in `computeWateringDecision`, **remove** the restriction block inside the cache-miss `else` (the whole `if ( checkRestrictions ) { ... }` block that fetches `wateringDataForRestriction` and calls `checkWeatherRestriction`). Then change the skip-overlay call. Replace:

```typescript
	decision = await applyWeatherSkips( decision, weatherProvider, coordinates, pws, adjustmentOptions );
```

with:

```typescript
	decision = await applyWeatherSkips( decision, weatherProvider, coordinates, pws, adjustmentOptions, undefined, checkRestrictions );
```

  (`checkRestrictions` is still computed near the top of `computeWateringDecision` from `adjustmentParam`; it is now used only as the `forceRain` flag.)

- [ ] **Step 4: Delete `checkWeatherRestriction`.** Remove the entire `export function checkWeatherRestriction( adjustmentValue: number, weather: BaseWateringData ): boolean { ... }` function from `routes/weather.ts`. If `BaseWateringData` is no longer referenced anywhere in the file, remove it from the `import { ... } from "../types";` line.

- [ ] **Step 5: Run the new tests, the regression suite, and the full suite.**

Run: `npm test -- --grep "force-enables the rain skip|LIVE over a cached"` → PASS.
Run: `npm test -- --grep "Watering Data"` → PASS (those tests don't set bit 7, so legacy output is unchanged).
Run: `npm test` → all pass. `npm run compile` → clean.

- [ ] **Step 6: Commit.**

```bash
git add routes/weather.ts routes/weather.spec.ts
git commit -m "feat(restrict): bit 7 force-enables the rain skip; remove checkWeatherRestriction [#restrict]"
```

> **Spec coverage note:** the unified-path test proves bit 7 → rain skip with a reason; the LIVE-over-cache test proves the cached method result is unrestricted and the rain decision is applied live on a cache hit (§4 of the spec). Fail-open and threshold/force semantics are covered in Tasks 1-2. The legacy regression suite proves non-restricted behavior is unchanged.

---

## Task 4: Documentation

**Files:**
- Modify: `docs/weather-skips.md`, `docs/v1-api.md`, `docs/mqtt.md`, `README.md`

- [ ] **Step 1: Update `docs/weather-skips.md`.** Add a section at the end:

```markdown
## Relationship to the firmware "rain restriction"

The OpenSprinkler firmware's rain/weather restriction (the adjustment-method restriction bit,
and `restrict=1` on the `/v1` API) is a **convenience alias for the rain skip**: when set, it
force-enables the rain rule above using the same `RAIN_SKIP` threshold (default 0.1in), even if
`SKIP_RAIN` is otherwise off. It is evaluated **live on every request** (not cached) and is
**fail-open** — if weather is unavailable, watering proceeds. When it fires, the response carries
the same `rawData.skip` / `rawData.skipReason` as any other rain skip.

Calendar restrictions (even/odd day, day-of-week, monthly/seasonal) are handled by the firmware's
own program scheduling, not by this service.
```

- [ ] **Step 2: Update `docs/v1-api.md`.** In the `GET /v1/watering` section, replace the `restrict` parameter description so it reads:

```markdown
`restrict` (optional `1`/`true`) — force-enables the rain skip (skip watering when recent precip
≥ `RAIN_SKIP`, default 0.1in), evaluated live and fail-open. Equivalent to the firmware's rain
restriction bit. When it fires, the response has `skip: true` + a rain `skipReason`.
```

- [ ] **Step 3: Update `docs/mqtt.md`.** In the "Notes" section, adjust the restriction line to:

```markdown
- `MQTT_RESTRICT=1` force-enables the rain skip for the published decision (same `RAIN_SKIP`
  threshold, live + fail-open), equivalent to the firmware restriction bit.
```

- [ ] **Step 4: Update `README.md`.** No new link is needed; if the weather-skips bullet mentions restrictions, leave it. (Skip this step if there is nothing restriction-specific to change.)

- [ ] **Step 5: Verify + commit.**

Run: `npm run compile` (clean).

```bash
git add docs/weather-skips.md docs/v1-api.md docs/mqtt.md README.md
git commit -m "docs(restrict): document the restriction bit as a rain-skip alias [#restrict]"
```

---

## Done criteria

- `npm test` green (existing suites + new force-rain, unified-path, and cache-hit-liveness tests), `npm run compile` clean.
- The restriction bit (firmware) / `restrict=1` (`/v1`) / `MQTT_RESTRICT` all route through the single rain-skip rule: live over cache, fail-open, configurable `RAIN_SKIP` threshold, emitting `skip`/`skipReason`.
- `checkWeatherRestriction` is gone; there is one rain code path.
- The legacy "Watering Data" regression suite passes unchanged (non-restricted behavior identical).

## Out of scope (per spec)
- Calendar restrictions (firmware-owned), non-rain skip changes, the cache-key scheme, adjustment-method math, or any new restriction types.
