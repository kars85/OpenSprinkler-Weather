# Project awareness — OpenSprinkler-Weather

This weather service is the **producer** of the watering-adjustment response consumed by the **OpenSprinkler-Firmware** controller. The legacy `&key=value` response is a **frozen, additive-only, size-bounded public API** — a change here can silently break controllers in the field.

## Coupling (consult before changing the response)

- **Canonical wire-format spec:** [`docs/firmware-integration-requirements.md`](docs/firmware-integration-requirements.md) — source of truth for what the firmware consumes.
- **CI guard:** `test/firmware-contract.spec.ts` — enforces the contract; keep it green.
- **Consumer-side counterpart (firmware repo):** `OpenSprinkler-Firmware/docs/weather-contract.md` — the firmware's hard constraints the producer must respect (`rawData` ≤ 319 bytes, `ETHER_BUFFER_SIZE` cap, AVR no-TLS, the `restricted`/`scales` records).
- **Coordination backlog:** [`docs/firmware-integration-backlog.md`](docs/firmware-integration-backlog.md) — mirrors the firmware issues (`kars85/OpenSprinkler-Firmware` #2/#3/#4).

## The rule
Wire-format changes land **here first** (this repo is canonical), keep them additive and size-bounded, update the CI guard, and update the firmware's `weather-contract.md` in step. The three-repo map lives at `OpenSprinkler-Firmware/docs/ecosystem.md`.

## Verification discipline
Verify firmware-side claims against the actual firmware source (`C:\Dev\OpenSprinkler-Firmware`) with `file:line` rather than assuming.

<!-- project-workflow:start -->
## Project work tracking and Empirica

Use [the project workflow](docs/agent-workflow.md) for implementation, maintenance, bug intake and idea intake. GitHub Issues in `kars85/OpenSprinkler-Weather` are the work tracker; keep acceptance, handoff and verification evidence there. Preserve local specs/runbooks as reference documents. This supersedes older local-only task-tracker instructions.

Run `python3 scripts/agent-workflow.py bootstrap` and `verify` when starting work; `session` opens this conversation's explicit Empirica session. The profile in `.agent-workflow.json` owns the project UUID, repository and checks. Use project-specific `opensprinkler-weather-abc` / `opensprinkler-weather-intake` skills or Claude `/abc` / `/intake`; keep findings scoped to this project. Existing safety and deployment constraints continue to apply.
<!-- project-workflow:end -->
