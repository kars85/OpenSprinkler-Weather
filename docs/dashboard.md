# Dashboard

A lightweight web dashboard at **`/dashboard`** that visualizes the `/v1` data — current
watering decision, weather, the Water-Budget rain-bank, a watering-scale history chart, and
recent decisions. It ships with the service (no build step, no extra dependency).

## Usage

Open `http://<host>:<port>/dashboard/` and enter a location (`lat,lon` or a geocodable string)
and an adjustment method (0 manual, 1 zimmerman, 2 rainDelay, 3 eto, 4 waterBudget). The
selection is saved to the URL (`?loc=...&method=4`) and `localStorage`, so you can bookmark it.
The page auto-refreshes every 5 minutes (and on the Refresh button).

The history chart and decisions appear once the Water-Budget method (4) has run for that
location at least once; before then they show an empty state.

## Security / scope

The dashboard and the `/v1` API it reads are **read-only and unauthenticated** — intended for
self-hosted/home use on a trusted network. All data is rendered as text (no HTML injection), and
the page loads only local assets (a `default-src 'self'` CSP, no CDN). It does not control the
controller; it only displays what the service computes.
