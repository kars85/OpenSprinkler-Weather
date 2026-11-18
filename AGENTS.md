\# OpenSprinkler-Weather Agent Instructions



\## Project purpose



This repository builds a Dockerized OpenSprinkler Weather Service for a homelab deployment.



Production uses:

\- Node.js / TypeScript

\- Express

\- Docker image published by GitHub Actions

\- Docker Compose deployment on a separate Docker host

\- Local Ecowitt weather station data

\- Weather Underground-compatible PWS format

\- `WEATHER\_PROVIDER=local`

\- `PWS=WU`



\## Important runtime boundaries



Do not commit or create real secrets.



Do not commit:

\- `.env`

\- `.env.\*`

\- API keys

\- `geocoderCache.json`

\- `observations.json`

\- `baselineEToData/Baseline\_ETo\_Data.bin`

\- `node\_modules`

\- compiled `js/` output



Runtime config lives outside the image and is mounted by Docker Compose.



\## Production behavior to preserve



Preserve local PWS / Ecowitt support.



Do not make Google Maps, Apple Weather, OpenWeatherMap, AccuWeather, or other cloud providers required for startup.



Cloud provider warnings should not break local mode.



Do not remove backward compatibility behavior unless explicitly requested.



\## Docker expectations



The Docker image should contain app code and dependencies only.



Runtime files are supplied through:

\- env\_file

\- bind-mounted observations file

\- bind-mounted geocoder cache

\- bind-mounted baseline ETo binary



Prefer small, safe Dockerfile improvements over broad rewrites.



\## Review/fix workflow



For first-pass reviews, do not modify files unless explicitly asked.



When modifying code:

1\. Explain the planned change.

2\. Keep changes small.

3\. Run `npm run compile`.

4\. Run available tests if practical.

5\. Summarize exactly what changed.

<!-- project-workflow:start -->
## Project work tracking and Empirica

Use [the project workflow](docs/agent-workflow.md) for implementation, maintenance, bug intake and idea intake. GitHub Issues in `kars85/OpenSprinkler-Weather` are the work tracker; keep acceptance, handoff and verification evidence there. Preserve local specs/runbooks as reference documents. This supersedes older local-only task-tracker instructions.

Apply local-only/offline/confidentiality constraints before GitHub or shared Empirica access; use local files and drafts when those services are outside scope. Read access alone does not permit bootstrap or session creation; use local/cached evidence when writes are outside scope. When Empirica initialization and session/evidence writes are authorized, run `python3 scripts/agent-workflow.py bootstrap` and `verify`; `session` opens this conversation's explicit Empirica session. The profile in `.agent-workflow.json` owns the project UUID, repository and checks. Use project-specific `opensprinkler-weather-abc` / `opensprinkler-weather-intake` skills or Claude `/abc` / `/intake`; keep findings scoped to this project. Existing safety and deployment constraints continue to apply.
<!-- project-workflow:end -->
