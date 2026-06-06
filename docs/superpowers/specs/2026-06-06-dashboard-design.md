# Dashboard UI — Design Spec

**Date:** 2026-06-06
**Status:** Approved for planning (pending user read-through)
**Feature:** A zero-build static `/dashboard` page, served by the existing Express app, that visualizes the `/v1` data (current watering decision, weather, and Water-Budget history) for an operator-entered location. No frontend framework, no build step, no new dependencies.

---

## 1. Problem & Goal

The `/v1` JSON API exposes watering decisions, weather, and Water-Budget history, but there is no human-facing view. **Goal:** a lightweight, self-contained dashboard that ships with the service and renders that data — surfacing the "decision-log" insight (rain-bank/scale history + decision reasons) that motivated the dashboard.

**Constraint (decided):** zero-build static page (HTML + vanilla JS + hand-rolled SVG), served by Express, consuming `/v1`. No bundler, framework, or new dependency — consistent with this backend repo.

This spec incorporates a four-way design review (`/octo:debate`, unanimous "ship-with-changes"); §6 (security) and §5 (testable helpers) are the hardening that review required.

---

## 2. Architecture

**Serving (`server.ts`):**
- Resolve the static dir once: `DASHBOARD_DIR = path.join(__dirname, "<rel>/public/dashboard")` (the `<rel>` chosen so it resolves from the compiled `js/` output to the repo's `public/dashboard`).
- **Assert it exists at startup** — if `fs.existsSync(DASHBOARD_DIR)` is false, log a clear warning (`Dashboard assets not found at <dir>; /dashboard disabled.`) and skip mounting (never silently fall through to the 404 handler).
- Mount: `app.use("/dashboard", express.static(DASHBOARD_DIR, { dotfiles: "deny", index: "index.html" }))`, registered **before** the 404 handler.

**Files under `public/dashboard/` (plain browser assets, not compiled):**
- `index.html` — markup only: location/method input bar, status cards, history chart `<svg>`, decisions `<table>`, an error/empty region. A `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`. **No inline `<script>` and no inline event handlers** (all JS in external files).
- `format.js` — **pure helpers, UMD-style** (`if (typeof module !== "undefined" && module.exports) module.exports = {...}`) so the browser loads it via `<script>` and Node/mocha can `require()` it. Contains the testable logic (§5). A header comment explains the UMD pattern and that it must not be converted to ESM/TS (it would break the dual-load).
- `app.js` — **thin browser-only shell** (intentionally integration-untested): calls `format.js` helpers, `fetch`es `/v1`, and writes results into fixed DOM nodes via `textContent` only. No data-shaping logic of its own.
- `style.css` — minimal responsive styling.

---

## 3. Data flow

All reads go through the already-shipped `/v1` API (`GET /v1/watering`, `/v1/weather`, `/v1/budget` — clean JSON, same-origin). On load and every 5 minutes (and on manual refresh), `app.js`:
1. resolves `loc`/`method` via `parseParams` (URL query → input fields → `localStorage`; persists the resolved values),
2. builds request URLs via `buildRequestUrls`,
3. `fetch`es the three endpoints with `{ cache: "no-store" }`, guarding `response.ok` and wrapping `JSON.parse`/network errors,
4. builds a render model via `buildViewModel` and writes it into the DOM (`textContent`),
5. renders the history chart via `buildHistoryPath`.

`/v1/budget` `404` (no state yet) ⇒ the history/table render an **empty-history message**, not an error. A `/v1/watering` or `/v1/weather` error renders a clean error state from the `{error:{code,message}}` JSON (message via `textContent`).

---

## 4. Refresh & fetch hygiene

- `fetch(url, { cache: "no-store" })` on every call (no stale browser-cached `/v1` JSON).
- An **in-flight guard** prevents overlapping loads; a **manual refresh clears and restarts** the 5-minute `setInterval` (no double-polling).
- Every fetch guards `response.ok`; non-OK with a JSON body renders its `error.message`; non-JSON / network / timeout renders a generic "couldn't reach the service" state. `JSON.parse` is wrapped in `try/catch`.

---

## 5. Pure, testable helpers (`format.js`)

| Function | Signature | Behavior |
|---|---|---|
| `parseParams` | `(search: string, store: {getItem,setItem}) → { loc, method }` | Precedence URL query → stored value → defaults (`method` default `4`). Validates `method` is an integer 0–4 (else default 4); returns `loc` as a plain string (no HTML). Persists resolved values to `store`. |
| `buildRequestUrls` | `({loc, method}) → { watering, weather, budget }` | URL-encodes `loc`; builds `/v1/watering?loc=..&method=..`, `/v1/weather?loc=..`, `/v1/budget?loc=..`. |
| `buildViewModel` | `({watering, weather, budget}) → { cards, history, decisions, empties }` | Maps the three `/v1` payloads (any may be an error/absent) into plain display strings/numbers; budget `null`/404 ⇒ `history: []` + `decisions: []` + an empty flag. Never returns HTML. |
| `buildHistoryPath` | `(values: number[], w: number, h: number) → { points: string, min, max }` | SVG polyline points for a line chart. Handles: empty ⇒ `points: ""`; single ⇒ a flat midline; all-equal ⇒ midline (no divide-by-zero); non-finite/negative values coerced/clamped sanely. Returns `min`/`max` for axis labels. |

`app.js` consumes only these; it owns no parsing/shaping/charting logic of its own.

---

## 6. Security (review-mandated)

- **XSS:** all dynamic content — `?loc=`, weather `description`, decision `reason`, error `message`, any `/v1` field — is inserted via `textContent`, `el.value`, or `createElement`/`setAttribute`. **`innerHTML`, `insertAdjacentHTML`, and inline event handlers are prohibited** for any data-derived content. The chart is built by setting SVG element attributes (`points`, `d`) via `setAttribute`, not by HTML string injection.
- **CSP:** `index.html` carries `Content-Security-Policy: default-src 'self'`; viable because all JS/CSS are external local files. (Global `helmet` headers still apply.)
- **No-auth exposure (accepted risk):** the dashboard and `/v1` are unauthenticated and read-only. For the self-hosted/home use case this is an **explicitly accepted risk**; future fields added to `/v1` that are sensitive must revisit auth. The dashboard does **not** broaden `/v1` CORS (it is same-origin).
- **Static serving:** `express.static` with `dotfiles: "deny"`; only `public/dashboard/` is exposed.

---

## 7. Chart

Hand-rolled SVG line chart of the Water-Budget history (watering `scale` per decision; rain-bank optionally as a second series is a non-goal for v1). The path comes from `buildHistoryPath` (§5). The `<svg>` uses `viewBox` + `preserveAspectRatio` for mobile reflow, with **min/max value labels** so the line is readable. Read-only, fixed-window (last N decisions from `/v1/budget?limit=`), single-series.

---

## 8. Testing

- **`public/dashboard/format.spec.ts`** (Mocha, runs the UMD `format.js` via `require`):
  - `parseParams`: URL>store>default precedence; invalid/out-of-range `method` → 4; persists resolved values.
  - `buildRequestUrls`: correct URL-encoding + paths.
  - `buildViewModel`: maps payloads; budget 404/null → empty history+decisions; an error payload → an error display field (no throw).
  - `buildHistoryPath`: empty → `""`; single → flat; all-equal → midline (no NaN/Infinity); negative/NaN handled; correct points for a known series; `min`/`max` returned.
- **`routes/dashboard.spec.ts`** (or appended): assert `public/dashboard/index.html` exists and contains the expected element ids + external script refs, and **contains no inline `<script>` and no `on*=` inline handlers** (a regex scan) — guards the CSP/XSS posture.
- The `express.static` mount + `app.js` DOM glue are not unit-tested (repo posture: server bootstrap untested, like the MQTT start); verified manually.

---

## 9. Affected files

| File | Change |
|------|--------|
| `public/dashboard/index.html`, `format.js`, `app.js`, `style.css` | **New.** The static dashboard. |
| `public/dashboard/format.spec.ts` | **New.** Pure-helper tests. |
| `routes/dashboard.spec.ts` | **New.** `index.html` presence + no-inline-JS scan. |
| `server.ts` | Resolve + existence-assert `DASHBOARD_DIR`; mount `express.static` (dotfiles denied) before the 404 handler. |
| `docs/dashboard.md` + `README.md` | **New/updated.** Usage (URL params, what it shows, the accepted no-auth note). |

No new npm dependencies.

---

## 10. Out of scope (non-goals — state in the PR)
- Auth, write/control actions, multi-site management, real-time push (polling only).
- Chart tooltips, zoom, date-range selection, multi-series.
- Any bundler, framework, CDN asset, or build step; jsdom/browser test stack.
- Broadening `/v1` CORS or adding `/v1` endpoints.

## 11. Nice-to-have (not blocking)
Axis/scale labels beyond min/max; `aria-label`s on controls; static-asset cache-busting; richer empty/loading states.
