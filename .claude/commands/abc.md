<!-- managed-by: _config\skills\abc\commands\abc.md -->
<!-- canonical-sha: 6d9b1aa273940a432a3b68aa13914139b74bd0a6d6f3b817f1d51169aae9392f -->
<!-- last-synced: 2026-06-05T00:39:22.335Z -->
---
command: abc
description: "Three-phase PM/Developer orchestration — Claude plans, Codex implements, Claude validates. Modes: single, --loop, --loopall (persistent until all issues closed)"
aliases:
  - abc-cycle
---

# /abc — Autonomous A/B/C Orchestration

## MANDATORY COMPLIANCE

When the user invokes `/abc`, execute the pipeline below. You are the **orchestrator** — stay lean, delegate to agents, and let the GitHub issue carry all state.

**Templates:** `.claude/templates/abc-phase-*.md` (read and interpolate at runtime). These files are rendered from `_config\skills\abc\templates\` against `.claude/skills.yaml` by the SessionStart sync hook.

---

## Constants (single source of truth)

```
CODEX_MODEL          = gpt-5.5
CODEX_REASONING      = high
CODEX_FAST_MODE      = true
CODEX_SERVICE_TIER   = fast
EMPIRICA_CMD         = empirica project-bootstrap --project-id OpenSprinkler-Weather --include-live-state --output json --depth auto
EMPIRICA_CMD_MINIMAL = empirica project-bootstrap --project-id OpenSprinkler-Weather --include-live-state --output json --depth minimal
EMPIRICA_HELPER      = node C:\\Dev\\_config\\skills\bin\abc-empirica.mjs --project-id OpenSprinkler-Weather
TRIAGE_HELPER        = node C:\\Dev\\_config\\skills\bin\abc-triage.mjs
CHECKOFF_HELPER      = node scripts/abc-checkoff.mjs
HELPER_CI_WAIT_INVOCATION = 
CI_REQUIRED_CHECKS        = 
CI_WAIT_TIMEOUT_SEC       = 1800
HELPER_VERSION_BUMP_INVOCATION = 
UNRELEASED_BULLETS_ACCUMULATOR = .abc-state/unreleased-bullets
PROJECT_ID           = OpenSprinkler-Weather
WORKING_DIR          = C:\Dev\OpenSprinkler-Weather
APP_DIR              = C:\Dev\OpenSprinkler-Weather
```

**Bash path normalization:** `WORKING_DIR` and `APP_DIR` may render as Windows
paths such as `C:\Dev\MyProject`. Inside Bash, never use those raw backslash
paths in `cd` or file operations; Bash consumes backslashes and turns them into
invalid paths like `C:DevMyProject`. Normalize with Node first:

```bash
REPO_DIR=$(node -e "process.stdout.write(process.argv[1].replace(/\\\\/g,'/'))" "C:\Dev\OpenSprinkler-Weather")
APP_DIR_BASH=$(node -e "process.stdout.write(process.argv[1].replace(/\\\\/g,'/'))" "C:\Dev\OpenSprinkler-Weather")
cd "$REPO_DIR"
```

**Empirica usage tiers:**
- `EMPIRICA_CMD` (full / `--depth auto`): used once at cycle start (preflight) and once in Phase C (Gate 3). Full project discovery.
- `EMPIRICA_CMD_MINIMAL` (`--depth minimal`): used for loop stop-condition checks (Step 8c). Reads vectors only, skips rediscovery. ~3-5s faster.
- `EMPIRICA_HELPER` (Node wrapper): preferred for **post-CHECK** integration calls (`gap`, `self-report`, `postflight`, `trajectory`). Cross-platform (no bash/jq), papers over CLI gotchas, returns clean JSON.
- **Transition commands MUST use bare `empirica` CLI** (`session-create`, `preflight-submit`, `check-submit`, `project-bootstrap`). The Sentinel firewall's `TRANSITION_COMMANDS` whitelist (`~/.claude/plugins/local/empirica/hooks/sentinel-gate.py`) matches the prefix `empirica `, NOT the helper's `node /path/abc-empirica.mjs` prefix. Calling the helper for transition commands from a closed-loop state (i.e. immediately after a prior cycle's POSTFLIGHT) gets denied with `Epistemic loop closed`. Bare CLI is mandatory in STEP 0a; the helper becomes safe to use everywhere else once CHECK has been submitted.

**Remote CI wait (Gate 5, mandatory when configured):** When `HELPER_CI_WAIT_INVOCATION` is non-empty, Phase C MUST wait for remote CI on the just-pushed SHA before reporting PASS or running the checklist checkoff. Default timeout is 1800 seconds (30 min). When empty (default), Gate 5 is silently skipped in Phase C and a one-time warning is surfaced in Phase A's PM-HANDOFF instead, preserving today's local-only Triple Gate behavior. The helper is project-local — it MUST NOT be `gh run watch` baked into the canonical template (consumer projects supply their own wrapper).

**Version-bump cadence (opt-in, issue #545):** When `HELPER_VERSION_BUMP_INVOCATION` is non-empty, the orchestrator runs exactly ONE patch bump per `/abc` invocation. Each PASS cycle composes a `- <Verb> <object> [#<issue>]` bullet from its commit subject and appends it to `UNRELEASED_BULLETS_ACCUMULATOR` (Step 5.9c) — it does NOT commit CHANGELOG per cycle, so the pre-push CHANGELOG guard is never engaged during cycles. The bump fires at **STEP 7** in single mode (end of the one cycle) or at **STEP 9** in `--loopall` mode (end of loop), shipping the loop's accumulated bullets as one coherent version. When empty (default), the entire mechanism — bullet accumulation and bump — is skipped, preserving today's no-bump behavior. The helper is project-local (it owns CHANGELOG `[Unreleased]` materialization + `version:bump --patch --tag --push` under the project's guard bypass); see `docs/specs/issue-545-version-bump-cadence-spec.md` for the exact contract. A bump failure is surfaced but is NON-BLOCKING — the cycles already shipped and CI is green; the bump can be re-run manually.

**Inline gotchas the skill body depends on (stay here):**
- **Goal status enum (1.8.5+):** canonical values are `planned | in_progress | completed`. Do NOT use `complete` or `active`. Open-work predicate is `is_completed = 0`. (Loop continuation and goals-list filters in this skill assume these strings.)
- **Codex config interpolation:** In Bash, do NOT write `-c 'model_reasoning_effort="$CODEX_REASONING"'`; single quotes prevent `$CODEX_REASONING` from expanding. Use `-c "model_reasoning_effort=\"$CODEX_REASONING\""` or a `CODEX_CONFIG_ARGS` array. (STEP 4 inlines this pattern.)
- **Codex Fast mode:** `/fast on` is interactive CLI syntax. Non-interactive `codex exec` MUST use config overrides: `-c "service_tier=\"fast\""` and `-c "features.fast_mode=true"`. (STEP 4 inlines these.)
- **Retry consistency:** Phase B initial attempt and retry attempt MUST use the same Codex invocation wrapper. Never duplicate an inline Codex command in the retry path. (STEP 6 depends on this.)

**Everything else lives in `_config\skills\EMPIRICA-RUNBOOK.md`** — `--depth` enum, UUID session-id requirement, bootstrap output shape, jq/Windows quoting traps, validated version range, provenance flags, `suggested_links`, `--description` bodies, `--visibility`, daemon description round-trip, `situation` block, CHECK gate framing, `deferred_proposals_note`, and Codex `-c` precedence. The `$EMPIRICA_HELPER` (`abc-empirica.mjs`) papers over the platform/quoting hazards at runtime — the skill body trusts the helper rather than re-encoding the changelog.

**Empirica failure policy:** Log WARN, continue on mechanical gates only. Never block a cycle on Empirica infra failure. Never use bare `empirica project-bootstrap` without `--project-id OpenSprinkler-Weather`. Firewall denials (`Epistemic loop closed`, `No open transaction`, `Submit PREFLIGHT`, `submit CHECK`) are NOT infra failures — they are skill-ordering bugs and must be treated as HARD STOPs.

---

## STEP 0: Parse Arguments

Three modes:

### Single-Issue Mode
```
/abc <issue-number>                    # auto-select next unchecked item
/abc <issue-number> --item "text"      # select specific checklist item
/abc <issue-number> --model <model>    # override Codex model
```

### Loop Mode
```
/abc --loop                            # work the full issue register
/abc --loop --epic 280                 # work only issues under a specific epic
/abc --loop --campaign security        # work only issues with a specific domain label
/abc --loop --max-cycles 5             # stop after N successful cycles
```

### LoopAll Mode (Persistent Execution)
```
/abc --loopall                         # persist until EVERY open issue is closed
/abc --loopall --checkpoint-every 5    # emit a CONTEXT CHECKPOINT marker every 5 cycles (default)
/abc --loopall --checkpoint-every 0    # disable checkpoint markers
```

`--loopall` rules:
- **No voluntary pauses.** Only hard stop conditions terminate the loop.
- **Qualitative re-ranking** every 10 cycles (Sonnet triage agent).
- **Circuit breaker:** 5 consecutive failures (vs 3 in loop mode).
- **Epistemic kill:** context gap > 0.25 (vs 0.2 in loop mode).
- **Context checkpoint:** every N completed cycles (N from `--checkpoint-every`, default 5), Step 8e emits a `CONTEXT CHECKPOINT` marker recommending the operator `/clear` for token savings. Calibration data, `.abc-failures.json`, `.abc-weights.json`, GitHub issue state, and Empirica artifacts all persist across `/clear`, so the next invocation continues progress without rework. Pass `--checkpoint-every 0` to silence the markers.

Extract: `MODE`, `ISSUE_NUM`, `ITEM_OVERRIDE`, `CODEX_MODEL` (default above), `EPIC_FILTER`, `CAMPAIGN_FILTER`, `MAX_CYCLES`, `CHECKPOINT_EVERY` (default `5` in loopall, ignored otherwise).

After parsing, **always** proceed to STEP 0a (open the epistemic transaction) before any other Bash. Step routing for the rest of the cycle: `MODE=single` → STEP 0a → STEP 2 (skip triage + batch plan). `MODE=loop|loopall` → STEP 0a → STEP 1 → STEP 1.5 (batch plan — opt-in, no-op unless `false=true`) → STEP 2.

---

## STEP 0a: Open Epistemic Transaction (BLOCKING — must precede ALL praxic Bash)

**Why this is Step 0a and not Step 2b:** The Sentinel firewall (`~/.claude/plugins/local/empirica/hooks/sentinel-gate.py`) denies all praxic Bash after a prior `POSTFLIGHT` until a new `PREFLIGHT` is open. Triage (Step 1 — `goals-prune`, `gh issue list | node $TRIAGE_HELPER`) and the environment check inside Step 2 (`gh auth status`, `$EMPIRICA_CMD`) are all praxic. So the epistemic transaction MUST open here — before any of those. Any Bash earlier than this step that isn't in the sentinel's safe-bash whitelist or transition-command list will be denied with `Epistemic loop closed (POSTFLIGHT completed)`.

**Why bare `empirica` CLI, not `$EMPIRICA_HELPER`:** See the "Transition commands" bullet above. Bare CLI is mandatory here; the helper becomes safe after Step 0a.4.

**Parser failure recovery:** If `session-create` printed `ok:true` and a `session_id` but Step 0a failed
before `preflight-submit`, do not run a recovery Bash block that starts with `EMP_SESSION=$(...)`,
`node`, `cat`, or any other non-`empirica` command. The Sentinel is still closed. Retry the full
Step 0a block after fixing the parser, or manually start with a bare `empirica preflight-submit -`
block that embeds the known `session_id` literal.

**Atomicity rule:** STEP 0a is one Bash block, not a sequence of exploratory Bash calls. The same
block that starts with bare `empirica session-create` must continue through session parsing,
`.abc-state/` writes, `preflight-submit`, and `check-submit`. Do not stop after `session-create`
to narrate, inspect `head`, assign `EMP_SESSION` in a later Bash call, or otherwise split setup
across turns. A successful `session-create` without `preflight-submit` leaves the Sentinel closed;
the next Bash call will be denied unless it starts with a bare transition command.

```bash
empirica session-create --ai-id claude-code-orchestrator --project-id OpenSprinkler-Weather --output json > .abc-session-create-response.json
# ^ CRITICAL: this MUST be the leading non-whitespace command in the STEP 0a bash block.
# The Sentinel firewall (`~/.claude/plugins/local/empirica/hooks/sentinel-gate.py`) prefix-matches
# `cmd.lstrip()` against TRANSITION_COMMANDS, and the firewall is in closed-loop state until
# preflight-submit fires. Bare `empirica session-create` matches; `$(empirica ...)` and
# `EMP_SESSION=$(...)` and leading `RUN_ID=$(date...)` all start with `$(` or `VAR=` after lstrip,
# none of which match the whitelist. The historical block (RUN_ID derived from `date | xxd` first,
# then $()-wrapped session-create) was therefore broken on fresh sessions — every cycle's first
# Bash got denied because nothing in the command prefix was transition-whitelisted. Once this
# leading command passes prefix-match, the sentinel allows the entire block through, so the
# $()-captures below for preflight/check responses are safe. See EMPIRICA-RUNBOOK.md
# "Sentinel prefix-match contract" for the full rule.

# 0a.1 — Derive session UUID + RUN_ID from the just-written response file.
# Why segregated ai-id: the /abc orchestrator is a deterministic state machine, not an exploratory
# agent — its PREFLIGHT/CHECK cycle has no noetic phase to calibrate. Submitting its vectors to the
# same Brier corpus as exploratory agents (claude-code) polluted the calibration channel with
# formula-as-self-assessment noise. Routing the orchestrator session to claude-code-orchestrator
# isolates the state-machine channel; real predictive calibration continues on claude-code via
# /intake, $EMPIRICA_HELPER gap, and downstream agent calls (which read calibration via the
# helper's default ai-id, not from this session).
EMP_SESSION=$(node -e "const fs=require('fs');let raw=fs.readFileSync('.abc-session-create-response.json','utf8').replace(/^\\uFEFF/,'').replace(/\\x1B\\[[0-?]*[ -/]*[@-~]/g,'');const a=raw.indexOf('{'),b=raw.lastIndexOf('}');const body=(a>=0&&b>=a)?raw.slice(a,b+1):raw;function pick(j){if(!j||j.ok===false)return '';return (typeof j.session_id==='string'&&j.session_id)||(j.session&&typeof j.session.session_id==='string'&&j.session.session_id)||(j.data&&typeof j.data.session_id==='string'&&j.data.session_id)||(j.result&&typeof j.result.session_id==='string'&&j.result.session_id)||'';}let id='';try{id=pick(JSON.parse(body));}catch(e){const m=raw.match(/\"session_id\"\\s*:\\s*\"([^\"]+)\"/);id=m?m[1]:'';}process.stdout.write(id||'')")
if [ -z "$EMP_SESSION" ]; then
  echo "FATAL: empirica session-create did not return a session_id. Cannot open transaction. STOP."
  echo "Response file (.abc-session-create-response.json):"
  cat .abc-session-create-response.json | head -20
  exit 1
fi

# RUN_ID is derived from the session UUID (first 8 chars). Gives a short unique identifier for
# GitHub trace correlation. Replaces the prior `date +%s | tail -c 7 ... xxd` dance, which
# required the bash block to lead with non-whitelisted commands and tripped the sentinel.
RUN_ID="${EMP_SESSION:0:8}"
echo "=== STEP 0a: OPEN EPISTEMIC TRANSACTION (run_id: $RUN_ID, session: $EMP_SESSION) ==="
# Per-cycle scratch file (RUN_ID suffix isolates parallel /abc panes). Phase C and Step 7/8c read this.
mkdir -p .abc-state
echo "$EMP_SESSION" > ".abc-state/emp-session-$RUN_ID"
# Cycle budget tracking — Step 7 reads this on PASS/FAIL to surface wall-clock duration.
# Epoch seconds; STEP 7 computes elapsed via `$(($(date +%s) - $(cat .abc-state/budget-start-$RUN_ID)))`.
# All cleanup paths (Step 5 PASS, Step 7 retry-exhaust, Step 8c external-close) remove this file.
# Replaces the prior pattern of orchestrators ad-libbing their own `date > /tmp/abc-budget-start`
# step BEFORE STEP 0a — which got denied by the sentinel firewall because the leading non-empirica
# command failed the transition-command prefix-match.
date +%s > ".abc-state/budget-start-$RUN_ID"

# 0a.2 — Submit PREFLIGHT with HONEST FIXED VECTORS for the orchestrator channel.
# Prior versions derived vectors from a formula (know = 0.85 - 0.04 * unknowns) and submitted them as
# self-assessment. That was theater: it looked like calibration but was deterministic arithmetic, which
# pollutes the Brier score with constant predictions. Fixed values + honest reasoning is the correct
# representation of "this is a state-machine transaction, not a predictive claim." See EMPIRICA-RUNBOOK.md
# "Orchestrator vs explorer calibration" for the full argument.
#
# CRITICAL (W4 — cascade prevention): capture the response and verify ok:true. Without this, a
# preflight-submit failure (network, daemon crash, malformed payload) leaves the session CREATED but
# the transaction NEVER OPENED — every subsequent praxic Bash in the cycle dies with "Epistemic loop
# closed", and the operator sees a cascade of unrelated denials instead of the actual root cause.
TASK_CTX_CI=$([ -n "" ] && echo "ci-wait=on:" || echo "ci-wait=off")
PREFLIGHT_RESPONSE=$(empirica preflight-submit - <<EOF
{
  "session_id": "$EMP_SESSION",
  "task_context": "/abc MODE cycle (run: $RUN_ID, $TASK_CTX_CI)",
  "vectors": {"know": 0.8, "uncertainty": 0.2, "context": 0.8, "engagement": 0.95},
  "reasoning": "Orchestrator-layer transaction (ai-id: claude-code-orchestrator, segregated from exploratory calibration corpus). Vectors are fixed nominal values, not a predictive claim — the orchestrator runs a deterministic state machine (arg parse, phase dispatch, gate enforcement). Exploration and prediction happen inside delegated Phase A (opus), Phase B (Codex), and Phase C (haiku) agent calls, which write to the claude-code channel via their own paths."
}
EOF
)
PREFLIGHT_OK=$(echo "$PREFLIGHT_RESPONSE" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.ok===true?'true':'false');}catch(e){process.stdout.write('false');}})")
if [ "$PREFLIGHT_OK" != "true" ]; then
  echo "=============================================="
  echo "FATAL: empirica preflight-submit returned ok:false (session created but transaction NOT opened)."
  echo "Session id: $EMP_SESSION"
  echo "Response (first 30 lines):"
  echo "$PREFLIGHT_RESPONSE" | head -30
  echo ""
  echo "Without an open transaction, every subsequent praxic Bash in this cycle will be denied by the"
  echo "Sentinel firewall with 'Epistemic loop closed'. STOPPING the cycle here so the cascade does not"
  echo "obscure the root cause. Diagnose with:"
  echo "  empirica calibration-report --ai-id claude-code-orchestrator --weeks 1   # daemon health"
  echo "  empirica session-status --session-id $EMP_SESSION                        # session state"
  echo "=============================================="
  rm -f ".abc-state/emp-session-$RUN_ID" .abc-session-create-response.json
  exit 1
fi

# 0a.3 — Submit CHECK with reasoning that matches the orchestrator's actual epistemic posture.
# CHECK is required to unblock praxic Bash after this point (goals-prune, gh issue list, codex exec,
# git add/commit/push). The decision is "ready" because the orchestrator's predictive surface IS the
# deterministic state machine — there is no further noetic work for it to do at this layer.
#
# Same W4 validation: a check-submit failure leaves the transaction half-open (preflight ran, CHECK
# never fired), and the firewall denies praxic Bash with a different but equally unhelpful message
# ('Submit CHECK to gate noetic->praxic'). Catch it here.
CHECK_RESPONSE=$(empirica check-submit - <<EOF
{
  "session_id": "$EMP_SESSION",
  "vectors": {"know": 0.8, "uncertainty": 0.2, "context": 0.8, "engagement": 0.95},
  "decision": "ready",
  "reasoning": "Orchestrator state machine fully primed: arguments parsed, project id resolved, transaction segregated to claude-code-orchestrator channel. No domain investigation belongs at this layer — Phase A handles issue scoping, Phase B handles implementation, Phase C handles validation. This CHECK is a structural gate-pass for the state machine, not a grounded-predictive claim."
}
EOF
)
CHECK_OK=$(echo "$CHECK_RESPONSE" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const dec=j.decision||j.computed_decision||'';process.stdout.write((j.ok===true && (dec==='proceed'||dec==='ready'))?'true':'false');}catch(e){process.stdout.write('false');}})")
if [ "$CHECK_OK" != "true" ]; then
  echo "=============================================="
  echo "FATAL: empirica check-submit did not return ok:true + decision:proceed (transaction half-open)."
  echo "Session id: $EMP_SESSION"
  echo "Response (first 30 lines):"
  echo "$CHECK_RESPONSE" | head -30
  echo ""
  echo "Preflight succeeded but CHECK did not gate noetic->praxic. Subsequent praxic Bash will be"
  echo "denied. STOPPING the cycle here so the cascade does not obscure the root cause."
  echo "If decision is 'investigate', the orchestrator vectors above are below the gate — review them"
  echo "or temporarily raise EMPIRICA_GATE_RELAXATION (see EMPIRICA-RUNBOOK.md). If ok:false, see the"
  echo "diagnose commands in the preflight FATAL above."
  echo "=============================================="
  # Note: not deleting .abc-state/emp-session-$RUN_ID — the transaction is half-open; operator may need
  # to inspect or manually close it via empirica postflight-submit before retry.
  exit 1
fi
# Both transitions succeeded — clean up the session-create response file (its session_id already
# lives in .abc-state/emp-session-$RUN_ID for downstream phases).
rm -f .abc-session-create-response.json
echo "=== Transaction opened: $EMP_SESSION (ai-id: claude-code-orchestrator, run_id: $RUN_ID) ==="
```

After Step 0a, the transaction stays open through Step 5 (Phase C). It closes in:
- Step 5.9 Gate 4 postflight on PASS (inline orchestrator)
- Step 5.10 FAIL postflight on FAIL (inline orchestrator)
- STEP 7 retry-exhaustion postflight on FAIL (belt-and-suspenders catch)
- Or remains open if a later cycle's PREFLIGHT supersedes it (Empirica policy — last writer wins)

Subsequent steps may now safely use either bare `empirica` CLI or the `$EMPIRICA_HELPER` wrapper.

---

## STEP 1: Triage — Issue Selection (Loop Modes Only)

### 1.0. Loopall Init — One-shot Goal Cleanup (loopall mode only, cycle 1)

On the very first cycle of `--loopall`, run a goal-graph cleanup so stale and duplicate goals from prior sessions don't pollute calibration during the run. Empirica 1.9.0 ships `goals-prune` for this. Default mode is dry-run; `--apply` mutates.

This runs **after** STEP 0a has opened the epistemic transaction and submitted CHECK=ready. `goals-prune` is state-mutating Bash that is not in the sentinel's safe-bash or transition whitelist — it requires an open transaction with CHECK ready to pass the firewall.

```bash
if [ "$MODE" = "loopall" ] && [ "$COMPLETED_CYCLES" = "0" ] && [ "$FAILED_CYCLES" = "0" ]; then
  PRUNE_OUTPUT=$(empirica goals-prune --auto-stale 14 --duplicates --apply --project-id OpenSprinkler-Weather --output json 2>&1 || true)
  echo "$PRUNE_OUTPUT" | tail -5
  if echo "$PRUNE_OUTPUT" | grep -qE 'Epistemic loop closed|No open transaction|Submit PREFLIGHT|submit CHECK'; then
    echo "FATAL: Sentinel firewall denied goals-prune. This is NOT a housekeeping failure — STEP 0a (Open Epistemic Transaction) did not run or did not complete successfully. STOP and fix the skill ordering before retrying. Do not paper over with a WARN."
    exit 1
  fi
fi
```

**Failure-handling contract (do NOT regress):**

| Failure signature in output | Treat as | Action |
|----------------------------|----------|--------|
| `Epistemic loop closed`, `No open transaction`, `Submit PREFLIGHT`, `submit CHECK` | **Firewall block** — skill ordering bug | **HARD STOP.** STEP 0a did not open the transaction before this call. Surface the error and abort the cycle. |
| Any other non-zero exit (CLI bug, missing project, network error, schema mismatch, etc.) | **Housekeeping failure** | Log a WARN and continue — never block the loop on housekeeping. Receipt is written to git notes (breadcrumbs ref) for audit trail. |

Treating a firewall block as a soft warning is a known anti-pattern — it masks the real ordering bug and propagates corrupt state into the rest of the loop. The firewall is a hard signal, not noise.

### 1a. Query and Score

```bash
REPO_DIR=$(node -e "process.stdout.write(process.argv[1].replace(/\\\\/g,'/'))" "C:\Dev\OpenSprinkler-Weather")
cd "$REPO_DIR" && rtk gh issue list --state open --limit 200 --json number,title,labels,body | $TRIAGE_HELPER --top 10
```

### 1b. Apply Filters

- `EPIC_FILTER`: filter to `#NNN` references in the epic issue body.
- `CAMPAIGN_FILTER`: filter to issues whose labels include the campaign domain.

### 1c. Qualitative Re-Ranking (loopall only, every 10 cycles)

On cycle 1 and every 10th cycle, spawn a **foreground Agent** (model: `sonnet`) to evaluate the top 5 issues by severity, clarity, unblock value, and staleness. Apply deltas (−20 to +20) to quantitative scores. Cache results for 10 cycles.

If the qualitative agent fails → fall back to pure quantitative scoring.

### 1d. Select Top Issue

Sort by final score descending. Ties: prefer lower issue number. Set `ISSUE_NUM`.

### 1e. Stop Conditions

| Condition | Loop | LoopAll |
|-----------|------|---------|
| No unchecked items remain | Stop | Stop |
| MAX_CYCLES reached | Stop | N/A |
| Consecutive failures | ≥ 3 | ≥ 5 |
| Empirica context gap | > 0.2 | > 0.25 |

Display between cycles:
```
--- Loop: cycle N | completed: X | failed: Y | remaining: Z ---
Next: #ISSUE_NUM — <title> (score: NN)
```

---

## STEP 1.5: Batch Plan (opt-in — loop modes only)

**Gate:** This step is a NO-OP unless `false` is `true` AND `MODE` is `loop` or `loopall`. When `false` is `false` (the default) or `MODE=single`, skip directly to STEP 2 — per-cycle Phase A (STEP 3) runs unchanged.

When enabled, plan ALL of the selected issue's unchecked items in ONE Phase A pass and cache the result, so subsequent cycles on the same issue pop a pre-computed plan instead of launching an opus Phase A agent each cycle (the dominant per-cycle non-CI cost — see the latency control contract). The cache is keyed to the issue body hash, so adding or editing items (e.g. a CI remediation item) regenerates the plan automatically.

```bash
RUN_ID=$(ls -t .abc-state/emp-session-* 2>/dev/null | head -1 | sed 's|.*emp-session-||')
BATCH_PLAN_READY=0
if [ "false" = "true" ] && { [ "$MODE" = "loop" ] || [ "$MODE" = "loopall" ]; }; then
  PLAN_FILE=".abc-state/batch-plan-ISSUE_NUM.json"
  BODY_HASH=$(gh issue view ISSUE_NUM --json body --jq .body | git hash-object --stdin)
  CACHED_HASH=$(node -e "let fs=require('fs');try{let j=JSON.parse(fs.readFileSync('$PLAN_FILE','utf8'));process.stdout.write(j.bodyHash||'')}catch(e){}")
  if [ -f "$PLAN_FILE" ] && [ "$BODY_HASH" = "$CACHED_HASH" ]; then
    echo "[batch-plan] cache hit for #ISSUE_NUM (body unchanged) — reusing plan."
    BATCH_PLAN_READY=1
  else
    echo "[batch-plan] cache miss/stale for #ISSUE_NUM — launching one batch Phase A pass."
    BATCH_PLAN_READY=0
  fi
fi
```

If `BATCH_PLAN_READY=0` AND the gate above is satisfied (batch enabled + loop mode), **launch a foreground Agent** (subagent_type: `plan`, model: `opus`) with the interpolated `.claude/templates/abc-phase-a-batch.md` (substitute `{{ISSUE_NUM}}`). The agent returns a fenced ```json block. Extract the JSON and persist it with the body hash so STEP 3 can replay it:

```bash
# AGENT_JSON = the json the batch agent returned (fence stripped).
node -e '
  const fs=require("fs");
  let plan; try { plan=JSON.parse(process.argv[1]); } catch(e){ console.error("batch-plan: bad JSON from agent:",e.message); process.exit(1); }
  plan.bodyHash=process.argv[2];
  fs.writeFileSync(".abc-state/batch-plan-ISSUE_NUM.json", JSON.stringify(plan,null,2));
  console.log("[batch-plan] cached "+(plan.items?plan.items.length:0)+" item(s) for #ISSUE_NUM");
' "$AGENT_JSON" "$BODY_HASH"
```

Handle the agent `status`:
- `EMPIRICA_PREFLIGHT_FAILED` → STOP with error (same contract as STEP 3).
- `NO_UNCHECKED_ITEMS` → in loop mode re-triage (STEP 1); remove any stale `.abc-state/batch-plan-ISSUE_NUM.json`.
- `OK` → cache written; proceed to STEP 2. Per-cycle STEP 3 pops items from this cache.

If the batch agent fails for any other reason (timeout, malformed output), log a WARN and proceed with `BATCH_PLAN_READY=0` — STEP 3 then falls back to the standard per-cycle Phase A agent, so a batch-plan failure never blocks the loop (it just forfeits the speedup for this issue).

---

## STEP 2: Preflight Check

```bash
# Restore RUN_ID from STEP 0a's per-cycle scratch file. Shell variables do not persist across
# orchestrator Bash tool calls, so we cannot rely on $RUN_ID being already set. Previously this
# block did `RUN_ID=$(date +%s | tail -c 7)...`, which produced a NEW RUN_ID different from
# STEP 0a's session-UUID-derived value — breaking every downstream `cat .abc-state/emp-session-$RUN_ID`
# lookup in Step 5/7/8c. We now read the most-recent abc-emp-session-* filename and extract its
# RUN_ID suffix so STEP 2 reuses the same identifier as the rest of the cycle.
RUN_ID=$(ls -t .abc-state/emp-session-* 2>/dev/null | head -1 | sed 's|.*emp-session-||')
[ -z "$RUN_ID" ] && RUN_ID="(unknown — STEP 0a tmpfile missing)"
echo "=== PREFLIGHT ==="
echo "run_id: $RUN_ID | mode: MODE | project: OpenSprinkler-Weather"
gh auth status 2>&1 | head -3
codex --version 2>&1 | head -1

echo "codex_model: $CODEX_MODEL"
echo "codex_reasoning: $CODEX_REASONING"
echo "codex_fast_mode: $CODEX_FAST_MODE"
echo "codex_service_tier: $CODEX_SERVICE_TIER"

case "$CODEX_REASONING" in
  minimal|low|medium|high) ;;
  *)
    echo "ERROR: invalid CODEX_REASONING=$CODEX_REASONING; expected minimal|low|medium|high"
    exit 1
    ;;
esac

case "$CODEX_FAST_MODE" in
  true|false) ;;
  *)
    echo "ERROR: invalid CODEX_FAST_MODE=$CODEX_FAST_MODE; expected true|false"
    exit 1
    ;;
esac

gh issue view ISSUE_NUM --json state,title --jq '"\(.state) — \(.title)"'
$EMPIRICA_CMD 2>&1 | head -5
```

Abort if: gh not authenticated, codex not installed, issue is CLOSED (in loop mode: skip and re-triage).

**Note:** The Empirica transaction is already open from STEP 0a. STEP 2 only validates that the cycle's *target issue* is in a workable state. If you find yourself wanting to call `session-create` or `preflight-submit` here, STEP 0a did not run — fix the skill ordering, do not paper over it.

---

## STEP 3: Phase A — PM Handoff (Agent)

### 3.0. Batch-plan fast path (opt-in — skips the per-cycle Phase A agent)

When `false` is `true` AND a cached plan exists at `.abc-state/batch-plan-ISSUE_NUM.json` (written by STEP 1.5), DO NOT launch the per-cycle Phase A agent. Instead:

1. Re-read the **live** issue body and find the first UNCHECKED item in priority order (`[P0]`→`[P1]`→`[P2]`→`[P3]`→untagged; document order within a tier). Matching the live body — not the cache — is mandatory so already-checked items are never re-selected.
2. Look up that item's plan in the cache by **exact `text` match**:
   - **Found** → set `SELECTED_ITEM` and `EXECUTION_STEPS` from the cached entry. If the cached entry has `verificationOnly:true`, route to STEP 3b (verification batch close). Otherwise post a concise PM-HANDOFF comment inline (below) and continue to STEP 3a-post (Empirica goal registration — still per item).
   - **Not found** (e.g. a remediation item appended after planning, or a text mismatch) → fall through to the standard per-cycle Phase A agent for this one item.
3. If NO unchecked items remain → the cache is spent: remove `.abc-state/batch-plan-ISSUE_NUM.json` and, in loop mode, re-triage (STEP 1).

Inline PM-HANDOFF for the batch fast path (deterministic — the orchestrator already holds the cached fields):

```bash
gh issue comment ISSUE_NUM --body "$(cat <<'HANDOFF_EOF'
<!-- octo:abc run=RUN_ID phase=pm-handoff issue=ISSUE_NUM -->
## PM-HANDOFF (batch-plan)

**Run:** RUN_ID
**Selected item:** SELECTED_ITEM
**Source:** batch plan (.abc-state/batch-plan-ISSUE_NUM.json)

### Execution Steps
<cached executionSteps, one numbered line each>

### Scope
- **In scope:** <cached scope.in>
- **Out of scope:** <cached scope.out>
<!-- /octo:abc -->
HANDOFF_EOF
)"
```

After the inline handoff, capture `selectedItem` and `executionSteps` from the cache and continue to STEP 3a-post exactly as the agent path would. The verification-only and `NO_UNCHECKED_ITEMS` routing is identical to the agent path below.

### 3.1. Standard per-cycle Phase A agent (default, and batch-plan fallback)

Run this when batch-plan is disabled, or when STEP 3.0 found no cached plan for the selected item.

Read `.claude/templates/abc-phase-a.md`. Substitute placeholders: `{{ISSUE_NUM}}`, `{{RUN_ID}}`, `{{ITEM_SELECTION_INSTRUCTION}}`, `{{ITEM_OVERRIDE_INSTRUCTION}}`.

Launch a **foreground Agent** (subagent_type: `plan`, model: `opus`) with the interpolated prompt.

**After the agent returns:**
- `NO_UNCHECKED_ITEMS` → in single mode: STOP. In loop mode: re-triage.
- `EMPIRICA_PREFLIGHT_FAILED` → STOP with error message.
- `VERIFICATION_ONLY` → skip Phase B, jump to STEP 3b.
- Otherwise → capture `selectedItem` and `executionSteps`.

### 3a-post. Register Empirica Goal (with 1.9.0 success criteria + subtask)

After capturing the selected item, create a trackable goal with a measurable success criterion. The criterion fires at Gate 4 postflight via `SubtaskCompletionEvaluator` (1.9.0+) — it requires the goal to have ≥1 subtask whose `is_completed=True` for the criterion to pass. Phase C marks that subtask just before postflight, so the criterion evaluates the actual gate-passage signal rather than the after-the-fact `goals-complete` call.

```bash
GOAL_ID=$(empirica goals-create \
  --objective "Implement: SELECTED_ITEM (issue #ISSUE_NUM)" \
  --success-criteria '["completion:subtask_ratio@>=1.0"]' \
  --project-id OpenSprinkler-Weather \
  --output json 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.goal_id||j.id||'');}catch(e){}})")

# Persist GOAL_ID to a per-cycle scratch file so cleanup paths (Step 5 PASS close,
# Step 7 retry-exhaust close, Step 8c external-close, Phase C FAIL close) can read
# it. Shell variables do NOT survive across orchestrator Bash tool calls — without
# this file the goals-complete calls below would close nothing and goals would leak.
# RUN_ID suffix isolates parallel /abc panes from each other.
echo "$GOAL_ID" > ".abc-state/goal-id-$RUN_ID"

if [ -n "$GOAL_ID" ]; then
  SUBTASK_ID=$(empirica goals-add-subtask \
    --goal-id "$GOAL_ID" \
    --description "Triple Gate passed cleanly (mechanical + code review + epistemic)" \
    --importance high \
    --output json 2>/dev/null \
| node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.task_id||j.subtask_id||j.id||'');}catch(e){}})")
  echo "$SUBTASK_ID" > ".abc-state/subtask-id-$RUN_ID"
fi

# Surface both IDs to orchestrator stdout so the Phase C template substitution
# (Step 5 below) can substitute them into {{GOAL_ID}} and {{SUBTASK_ID}}.
echo "GOAL_ID=$GOAL_ID"
echo "SUBTASK_ID=${SUBTASK_ID:-}"
```

Capture both `GOAL_ID` and `SUBTASK_ID` for the Phase C template (Step 5 substitution). If either CLI call fails, log a WARN and continue with empty IDs — Phase C handles missing IDs gracefully. The objective string includes `issue #ISSUE_NUM` so it is greppable from `goals-list` output even if the scratch file is lost.

Empirica `goals-add-subtask` has returned different identifier fields across
versions. Treat `task_id`, `subtask_id`, and `id` as equivalent subtask
identifiers. Do not retry solely because one field name is absent; retrying can
create duplicate subtasks when the CLI returned `ok:true` with `task_id`.

**Why subtask + criterion (1.9.0 grammar):** `"completion:subtask_ratio@>=1.0"` parses to `validation_method=completion`, `description=subtask_ratio`, `threshold=1.0`. `SubtaskCompletionEvaluator` reads `goal.calculate_progress().completion_percentage / 100` and passes when ≥ threshold. Without the subtask, the evaluator returns `skipped` ("no signal").

### STEP 3b: Verification Batch Close (skip Codex)

When ALL remaining items are verification-only:
1. Run mechanical gate (vitest + build + audit).
2. Grep/read code to confirm verification items.
3. Check off all verified items on the issue body.
4. Post a single PM-VALIDATION comment.
5. If all items checked → close the issue.
6. Skip to Step 8 (loop continuation).

---

## STEP 4: Phase B — Developer Implementation (Codex)

Read `.claude/templates/abc-phase-b.md`. Substitute: `{{ISSUE_NUM}}`, `{{RUN_ID}}`, `{{SELECTED_ITEM}}`, `{{EXECUTION_STEPS}}`.

**Write the interpolated prompt to a file, then pipe via stdin.** Passing the prompt as a positional argument breaks on Windows (and inside Bash/PowerShell tool sandboxes) because backticks, `$`, and double quotes in the prompt body get parsed by the shell before codex sees them — resulting in `command not found` errors and a hung codex waiting on stdin. The stdin pipe + `-` arg also avoids the codex TUI rendering path that hangs from non-interactive harnesses.

**Wrapper is the single source of truth.** This wrapper handles model, reasoning effort, fast mode, working directory, and Codex `-c` config overrides. STEP 6 (retry) re-invokes Codex by referencing this wrapper rather than inlining a second `codex exec`, so a change here automatically applies to both attempts.

Invoke via Bash:
```bash
PROMPT_FILE=".abc-state/phase-b-prompt-$RUN_ID.md"
cat > "$PROMPT_FILE" <<'PROMPT_EOF'
<interpolated prompt>
PROMPT_EOF

CODEX_CONFIG_ARGS=(
  -c "model_reasoning_effort=\"$CODEX_REASONING\""
)
if [ "$CODEX_FAST_MODE" = "true" ]; then
  CODEX_CONFIG_ARGS+=(
    -c "service_tier=\"$CODEX_SERVICE_TIER\""
    -c "features.fast_mode=true"
  )
fi

echo "=== CODEX EXEC ==="
echo "model: $CODEX_MODEL"
echo "reasoning: $CODEX_REASONING"
echo "fast_mode: $CODEX_FAST_MODE"
echo "service_tier: $CODEX_SERVICE_TIER"

cat "$PROMPT_FILE" | codex exec \
  --dangerously-bypass-approvals-and-sandbox \
  --ignore-rules \
  --color never \
  --skip-git-repo-check \
  -s workspace-write \
  -C "C:\Dev\OpenSprinkler-Weather" \
  -m "$CODEX_MODEL" \
  "${CODEX_CONFIG_ARGS[@]}" \
  -
rm -f "$PROMPT_FILE"
```

The required flags are not optional:
- **`-`** (stdin): keeps backticks, double quotes, and `$` in the prompt out of shell parsing.
- **`--ignore-rules`**: skips codex's own `.rules` file detection. _config has a pwsh-vs-powershell rule that codex self-blocks on; managed projects may have similar.
- **`--color never`**: disables TUI rendering that hangs from non-interactive sandboxes.
- **`--skip-git-repo-check`**: lets codex run cleanly inside fixtures or sub-checkouts that don't carry a `.git` codex expects.
- **`-s workspace-write`**: matches the orchestrator's expectation that codex can write to `C:\Dev\OpenSprinkler-Weather` and only `C:\Dev\OpenSprinkler-Weather`.
- **`CODEX_CONFIG_ARGS` array**: avoids the single-quote interpolation trap (`-c 'model_reasoning_effort="$X"'` does NOT expand `$X`). The fast-mode block conditionally appends `service_tier` + `features.fast_mode=true` when `CODEX_FAST_MODE=true`.

**Timeout:** 600000ms. If timeout → infra failure, post PM-REJECTION, no retry.

**After Codex returns:**
- Non-zero exit + no DEV-EXECUTION comment → infra failure, STOP.
- DEV-EXECUTION reports test sanity FAIL → **short-circuit**: post PM-REJECTION, skip Phase C, jump to Step 6 retry.
- Otherwise → proceed to Phase C.

---

## STEP 5: Phase C — Triple Gate + Push + Validate (inline orchestrator)

**No agent delegation.** The orchestrator runs the Triple Gate + commit/push + PM-VALIDATION inline as deterministic Bash steps and dispatches the code-review/security subagents directly. Prior implementations launched a Phase C agent (haiku, then sonnet) which short-circuited at Gate 2 PASS in multiple cycles, leaving Gates 3/3.5/4/5, commit, push, and PM-VALIDATION unrun. The orchestrator's URL-marker check + Step 6 retry caught it, but each early-return cost a full retry cycle. Running inline eliminates that failure class entirely.

Historical note: the previous canonical shipped a separate `.claude/templates/abc-phase-c.md` template that the orchestrator interpolated and handed to a sonnet agent. That template was deleted in this refactor; its content is absorbed below.

State this step depends on (set earlier in the cycle):
- `ISSUE_NUM`, `RUN_ID`, `SELECTED_ITEM`, `ATTEMPT_NUMBER` (1 or 2) — orchestrator-tracked
- `GOAL_ID`, `SUBTASK_ID` — written to `.abc-state/goal-id-$RUN_ID` and `.abc-state/subtask-id-$RUN_ID` by Step 3a-post

Per-step routing: if any gate fails, set `GATE_RESULT=fail`, `FAILED_GATE="<gate name>"`, jump to **Step 5.10 (FAIL path)**. Otherwise continue to the next sub-step.

### Step 5.1: Read DEV-EXECUTION context

```bash
DEV_EXECUTION=$(gh issue view ISSUE_NUM --json comments --jq '.comments | map(select(.body | contains("run=RUN_ID") and contains("phase=dev-execution"))) | last | .body')
```

The DEV-EXECUTION comment was posted by Phase B (Codex). Use it as the source of truth for what was implemented when composing the PM-VALIDATION later.

### Step 5.2: Gate 1 — Mechanical (parallel execution with audit cache)

**Check audit cache:**

```bash
REPO_DIR=$(node -e "process.stdout.write(process.argv[1].replace(/\\\\/g,'/'))" "C:\Dev\OpenSprinkler-Weather")
APP_DIR_BASH=$(node -e "process.stdout.write(process.argv[1].replace(/\\\\/g,'/'))" "C:\Dev\OpenSprinkler-Weather")
PACKAGE_LOCK_HASH=$(cd "$REPO_DIR" && git hash-object package-lock.json)
LAST_AUDIT_HASH=$(cat "$REPO_DIR/.abc-audit-hash" 2>/dev/null || echo "")
if [ "$PACKAGE_LOCK_HASH" = "$LAST_AUDIT_HASH" ]; then SKIP_AUDIT=1; else SKIP_AUDIT=0; fi
```

**Run gates in parallel** (vitest + build + audit + optional lint):

```bash
cd "$APP_DIR_BASH"
# Defer-CI cadence (LOOP MODES ONLY): per-cycle Gate 1 runs the fast changed-files
# test set; the full coverage run happens once at issue end (STEP 8c.5, reachable only
# in loop/loopall). In single mode — or when defer is off (default) — the full coverage
# command runs every cycle, because single mode never reaches the end-of-issue gate and
# must therefore fully verify each item per cycle. Build always runs per cycle either
# way — it is the per-commit type/compile safety net.
if [ "false" = "true" ] && [ -n "npm test" ] && { [ "$MODE" = "loop" ] || [ "$MODE" = "loopall" ]; }; then
  GATE1_TEST_CMD="npm test"
else
  GATE1_TEST_CMD="npm test"
fi
($GATE1_TEST_CMD > "$TMPDIR/gate1-vitest.log" 2>&1) & VITEST_PID=$!
(npm run compile > "$TMPDIR/gate1-build.log" 2>&1) & BUILD_PID=$!
if [ "$SKIP_AUDIT" = "1" ]; then
  AUDIT_RC=0; AUDIT_PID=""
  echo "audit: SKIPPED (lockfile unchanged)" > "$TMPDIR/gate1-audit.log"
else
  (npm audit --audit-level=high > "$TMPDIR/gate1-audit.log" 2>&1) & AUDIT_PID=$!
fi
# Opt-in lint runner. Empty placeholder → silently skipped. The brace
# group `{ ... ; }` is mandatory because  is often a `&&`-chain
# ("eslint src/ && prisma validate && ...") and without it the redirect
# only captures the last chained command.
if [ -n "" ]; then
  ( {  ; } > "$TMPDIR/gate1-lint.log" 2>&1 ) & LINT_PID=$!
else
  LINT_RC=0; LINT_PID=""
  echo "lint: SKIPPED (LINT_CMD empty in skills.yaml)" > "$TMPDIR/gate1-lint.log"
fi
wait $VITEST_PID; VITEST_RC=$?
wait $BUILD_PID;  BUILD_RC=$?
[ -n "$AUDIT_PID" ] && { wait $AUDIT_PID; AUDIT_RC=$?; }
[ -n "$LINT_PID" ] && { wait $LINT_PID; LINT_RC=$?; }
```

**Decision:** any non-zero exit → `FAILED_GATE="mechanical"`, jump to Step 5.10.

**Refresh audit cache on PASS:**

```bash
if [ $VITEST_RC -eq 0 ] && [ $BUILD_RC -eq 0 ] && [ $AUDIT_RC -eq 0 ] && [ $LINT_RC -eq 0 ]; then
  echo "$PACKAGE_LOCK_HASH" > "$REPO_DIR/.abc-audit-hash"
fi
```

### Step 5.3: Gate 2 — Code Review (OpenSprinkler-Weather-calibrated, orchestrator-dispatched subagents)

Capture the diff:

```bash
CHANGED_FILES=$(rtk git diff --name-only)
```

**Launch a foreground Agent** (subagent_type: `code-reviewer`, model: `opus`) with a prompt instructing it to review the changed files (`$CHANGED_FILES`) against `.claude/templates/abc-review-checklist.md` and return structured Important / Nit / OK findings. Universal Important checks (always reject):
- Correctness: does the change implement the selected item?
- Scope: did Phase B stay within PM-HANDOFF scope?
- Security: no new injection, auth bypass, or secret exposure?

**Conditional security escalation:** if any changed file matches a path listed under `domain_paths` in `.claude/skills.yaml`:
- _(no domain paths configured — security escalation disabled)_

ALSO launch a parallel **foreground Agent** (subagent_type: `voltagent-qa-sec:security-auditor`, model: `opus`) with the same diff and checklist context. Wait for both.

**Decision:** any Important finding from either subagent → `FAILED_GATE="code_review"`, jump to Step 5.10. Capture a one-line PASS summary or the failing-finding text for the PM-VALIDATION / PM-REJECTION body.

### Step 5.4: Gate 3 — Epistemic (Empirica gap)

```bash
GAP_JSON=$(node C:\\Dev\\_config\\skills\bin\abc-empirica.mjs --project-id OpenSprinkler-Weather gap 2>&1)
GAP_STATUS=$(echo "$GAP_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.context?.status||'unknown');}catch(e){process.stdout.write('unknown');}})")
case "$GAP_STATUS" in
  REJECT) GATE_EPISTEMIC="failed";  FAILED_GATE="epistemic"; ;;
  WARN)   GATE_EPISTEMIC="warned"; ;;
  OK)     GATE_EPISTEMIC="passed"; ;;
  *)      GATE_EPISTEMIC="skipped"; ;;  # helper failed — non-blocking per Empirica failure policy
esac
```

If `GATE_EPISTEMIC=failed` → jump to Step 5.10.

> Do NOT extract vectors from `project-bootstrap` output — bootstrap returns `{ok, project_id, project_name, breadcrumbs}` only. Vectors come from `calibration-report` (which the helper wraps).

### Step 5.5: Gate 3.5 — Mark gate-passage subtask complete

Phase A registered a goal with criterion `"completion:subtask_ratio@>=1.0"` and one subtask. For `SubtaskCompletionEvaluator` to pass at Step 5.9 postflight (rather than skip), the subtask must be marked completed BEFORE postflight runs:

```bash
if [ -n "{{SUBTASK_ID}}" ]; then
  empirica goals-complete-subtask --subtask-id "{{SUBTASK_ID}}" \
    --evidence "Triple Gate PASS in run RUN_ID (vitest+build+audit+lint, code-review, epistemic=$GATE_EPISTEMIC)" \
    --output json 2>&1 | tail -3 || true
fi
```

If `{{SUBTASK_ID}}` is empty (Phase A `goals-add-subtask` failed), this is a no-op — criterion evaluates to `skipped` instead of `passed` (informative, non-blocking).

### Step 5.6: Commit + Push

> **CHANGELOG guard.** Verify CHANGELOG.md is not modified or staged before staging anything else. Prior /abc cycles auto-appended CHANGELOG entries on every commit, and `git pull --rebase` replayed those entries on each push, creating duplicate lines and recurring rebase conflicts. The defensive restore/checkout is the recursion countermeasure — Phase B is allowed to write a CHANGELOG entry by habit, but the orchestrator strips it before the commit lands. CHANGELOG updates are release-time only (via `npm run version:bump`), never per-cycle.

```bash
if git status --short | grep -qE "(M|A) CHANGELOG.md"; then
  git restore --staged CHANGELOG.md 2>/dev/null || true
  git checkout -- CHANGELOG.md 2>/dev/null || true
fi
```

**Capture the intended commit message to a per-cycle scratch file** BEFORE the commit step runs. Step 5.9a's orchestrator self-verification reads this and compares to the post-push origin/master HEAD message; a mismatch indicates the pre-push hook absorbed staged work into the previous merged commit (the dc8174e2/606a80ed/bf76ee59/47665bfa cluster of 2026-05-23 was the canonical example). **Compose a fresh summary from the PM-HANDOFF context — do NOT copy from recent `git log` or you'll mask the bug class this detection net is meant to catch.**

```bash
INTENDED_MSG="feat(weather): <concise summary> [#ISSUE_NUM]"
echo "$INTENDED_MSG" > ".abc-state/intended-msg-RUN_ID"

# Stage only the files intentionally changed for the selected checklist item.
# Never use broad directory staging such as `git add ./` or
# `git add -u ./`; those can sweep unrelated artifacts such as
# `web/{}` or concurrent workflow/skill edits into the feature commit.
#
# Populate this list from the DEV-EXECUTION comment plus the Gate 2 diff-scope
# review. Keep one repo-relative file path per line. Do not include directories.
INTENDED_STAGE_FILES=$(cat <<'STAGE_EOF'
<repo-relative-file-1>
<repo-relative-file-2>
STAGE_EOF
)
printf '%s\n' "$INTENDED_STAGE_FILES" \
  | sed '/^[[:space:]]*$/d' > ".abc-state/stage-files-RUN_ID"
while IFS= read -r path; do
  case "$path" in
    '<repo-relative-file-'*)
      echo "FATAL: replace placeholder staged path before committing: $path"
      exit 1
      ;;
  esac
  if [ -d "$path" ]; then
    echo "FATAL: refusing to stage directory path: $path"
    exit 1
  fi
  if [ ! -e "$path" ] && ! git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    echo "FATAL: intended staged file does not exist and is not tracked: $path"
    exit 1
  fi
  rtk git add -- "$path"
done < ".abc-state/stage-files-RUN_ID"
rtk git commit -m "$INTENDED_MSG

Co-Authored-By: Codex <noreply@openai.com>"
rtk git fetch origin master
LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse origin/master)
if git merge-base --is-ancestor "$LOCAL_HEAD" "$REMOTE_HEAD"; then
  echo "Remote already contains local HEAD; no push needed."
elif git merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD"; then
  echo "Local HEAD is ahead of origin/master; safe to push without pull --rebase."
else
  echo "FATAL: local HEAD and origin/master diverged. Do not pull --rebase with unrelated dirty files."
  echo "Inspect with: git log --oneline --graph --decorate --max-count=20 HEAD origin/master"
  exit 1
fi
rtk git push
```

**Post-push artifact-graph verification (1.9.0+):**

```bash
COMMIT_SHA=$(git rev-parse HEAD)
COMMIT_CTX=$(empirica commit-context "$COMMIT_SHA" --depth 1 --output json 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const a=j.artifacts||{};const n=Object.values(a).reduce((s,v)=>s+(Array.isArray(v)?v.length:0),0);process.stdout.write(String(n));}catch(e){process.stdout.write('?');}})")
```

**Compliance evidence (1.9.0+, --security only):**

```bash
COMPLIANCE_JSON=$(empirica compliance-report --security --output json 2>/dev/null || echo '{}')
SEMGREP_FINDINGS=$(echo "$COMPLIANCE_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(String(j.security?.findings_count ?? j.semgrep?.findings_count ?? 0));}catch(e){process.stdout.write('?');}})")
```

If `SEMGREP_FINDINGS > 0`, surface the count in PM-VALIDATION but do NOT reject — Gate 2 is the authoritative security gate; this is supplemental.

### Step 5.7: Gate 5 — Remote CI wait (mandatory when  configured, post-push)

> **Why post-push, not pre-push:** observes the actual gate the cycle was meant to satisfy (the new SHA), not the previous baseline. See _config issue #55.

Initialize state:

```bash
GATE_CI="never_ran"
CI_WARNING=""
CI_CONCLUSION="not_run"
CI_RUN_URL=""
CI_FAILED_CHECKS=""
```

If `` is empty, silently mark Gate 5 skipped and proceed to Step 5.8:

```bash
GATE_CI="skipped_unconfigured"
CI_CONCLUSION="skipped"
CI_RUN_URL="(not observed)"
CI_FAILED_CHECKS="(none)"
```

**Defer-to-issue-end (opt-in — LOOP MODES ONLY):** If `false` is `true`, the helper is configured, AND `MODE` is `loop`/`loopall`, DO NOT wait for remote CI this cycle. Mark it deferred and proceed to checkoff — the full remote CI runs ONCE at issue end (STEP 8c.5, reachable only in loop modes), and a red result there drives the CI-RED-REMEDIATION control loop. **Single mode never defers** (it never reaches STEP 8c.5), so each single-mode item is CI-verified per cycle:

```bash
if [ "false" = "true" ] && { [ "$MODE" = "loop" ] || [ "$MODE" = "loopall" ]; }; then
  GATE_CI="deferred"
  CI_CONCLUSION="deferred"
  CI_RUN_URL="(deferred to issue end)"
  CI_FAILED_CHECKS="(none)"
fi
```

Otherwise — helper configured AND NOT (defer in a loop mode) — wait for CI on the just-pushed SHA:

```bash
COMMIT_SHA=$(git rev-parse HEAD)
CI_RESULT=$( \
  --commit-sha "$COMMIT_SHA" \
  --required-checks "" \
  --timeout-sec 1800 \
  --output json 2>&1)
CI_RC=$?
CI_RUN_URL=$(echo "$CI_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.run_url||'');}catch(e){}})")
CI_CONCLUSION=$(echo "$CI_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.conclusion||'unknown');}catch(e){process.stdout.write('unknown');}})")
CI_FAILED_CHECKS=$(echo "$CI_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const f=(j.checks&&j.checks.failed)||[];process.stdout.write(f.join(','));}catch(e){}})")

if [ $CI_RC -eq 0 ]; then
  GATE_CI="passed"
elif [ -n "$CI_RUN_URL" ] || [ "$CI_CONCLUSION" != "not_run" -a "$CI_CONCLUSION" != "unknown" ]; then
  GATE_CI="failed"; FAILED_GATE="ci_$CI_CONCLUSION"
else
  GATE_CI="never_ran"; FAILED_GATE="ci_never_ran"
fi
```

On `GATE_CI=failed` or `GATE_CI=never_ran` → jump to Step 5.10 (preserve `[ ]` so the next cycle re-selects this item; surface `$CI_RUN_URL` in PM-REJECTION + FAIL postflight `coverage.failed_gate`).

### Step 5.8: Checkoff (only after Gate 5 PASS or silently skipped)

```bash
case "$GATE_CI" in
  passed|skipped_unconfigured|deferred)
    # `deferred`: defer-to-issue-end cadence — item checks off on the local Triple
    # Gate; the remote CI verdict for the whole issue is collected at STEP 8c.5.
    node scripts/abc-checkoff.mjs --issue ISSUE_NUM --exact "- [ ] SELECTED_ITEM"
    ;;
  failed|never_ran|*)
    # Fall through to Step 5.10. Preserve [ ] for retry.
    ;;
esac
```

**Self-verification (BLOCKING per issue #418 — DO NOT SKIP):** helpers can lie. A helper can exit 0, print success-shaped JSON, and have done nothing — for example, a stubbed fixture implementation, or a real implementation that ran into an `gh` auth/rate-limit failure but swallowed the error. **The only authoritative truth is the GitHub issue body itself.**

```bash
gh issue view ISSUE_NUM --json body --jq .body | grep -F -- "- [x] SELECTED_ITEM" \
  || { FAILED_GATE="checkoff_unverified"; }
```

Treat ANY of the following as cycle FAILED — jump to Step 5.10:
- `grep` exits non-zero (the `[x]` line is not present in the live body; use `grep -F --` because checklist lines begin with `-`)
- The helper printed `"stub"`, `"would have toggled"`, `"dryRun":true`, or any other phrase suggesting it did not actually edit
- The helper exited non-zero

### Step 5.8a: Post PM-VALIDATION comment (pre-postflight)

Post PM-VALIDATION **before** the Gate 4 postflight closes the Empirica transaction. The postflight signals the Sentinel firewall (`Epistemic loop closed`), which then denies every subsequent praxic Bash call on the closed loop — `gh issue comment` posted afterwards is rejected (observed on `/abc 545` cycle 1). Posting here keeps the praxic gate open through the gh call.

`$COMMIT_SHA` and `$INTENDED_MSG` are re-derived here so this step is self-contained: Phase C wrote the intended message to `.abc-state/intended-msg-RUN_ID` before commit, and HEAD is already on `origin/master` after Phase C's push. `$CI_WARNING`, `$GATE_EPISTEMIC`, `$CI_CONCLUSION`, `$CI_RUN_URL`, `$CI_FAILED_CHECKS`, `$GATE_CI`, `$COMMIT_CTX`, `$SEMGREP_FINDINGS` were set in earlier steps (5.5–5.7).

```bash
COMMIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
INTENDED_MSG=$(head -1 ".abc-state/intended-msg-RUN_ID" 2>/dev/null || echo "")
PM_BODY_FILE=".abc-state/pm-validation-RUN_ID.md"
cat > "$PM_BODY_FILE" <<PM_VALIDATION_EOF
<!-- octo:abc run=RUN_ID phase=pm-validation issue=ISSUE_NUM -->
## PM-VALIDATION

**Run:** RUN_ID
**Cycle:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Selected item:** SELECTED_ITEM
**Result:** PASS
$CI_WARNING

### Triple Gate Results
| Gate | Result | Evidence |
|------|--------|----------|
| Mechanical | PASS | vitest: <N> tests, build: <T>s, audit: 0 vulns |
| Code Review | PASS | <one-line summary from Gate 2> |
| Epistemic | $GATE_EPISTEMIC | context gap: <X.XX> |

### Commit
$COMMIT_SHA — $INTENDED_MSG

### Supplemental Evidence
| Source | Value | Notes |
|--------|-------|-------|
| commit-context artifacts | $COMMIT_CTX | findings/decisions/dead-ends linked to this SHA (1-hop) |
| compliance-report --security findings | $SEMGREP_FINDINGS | supplemental; Gate 2 is authoritative |

### Remote CI (Gate 5)
| Field | Value |
|-------|-------|
| Conclusion | $CI_CONCLUSION |
| Run URL | $CI_RUN_URL |
| Required checks |  |
| Failed checks | $CI_FAILED_CHECKS |
| Status | $GATE_CI |

### Next Recommended Item
<next unchecked item, or All items complete>
<!-- /octo:abc -->
PM_VALIDATION_EOF
PM_VALIDATION_URL=$(gh issue comment ISSUE_NUM --body-file "$PM_BODY_FILE" 2>/dev/null | tail -1)
```

### Step 5.9: Gate 4 — Empirica Postflight (PASS path)

Close the Empirica transaction opened by Phase A's preflight. The session UUID was stored in `.abc-state/emp-session-RUN_ID` (per-cycle file to avoid collisions across parallel `/abc` panes). The postflight includes a `coverage` block (1.8.18+) — documented dimensions plus free-form keys recording what the cycle actually reached. Coverage is informative (never gating) and gets echoed to the next preflight as `previous_transaction_feedback`.

```bash
EMP_SESSION=$(cat ".abc-state/emp-session-RUN_ID")
FILES_TOUCHED=$(git diff --name-only HEAD 2>/dev/null | wc -l | tr -d ' ')
TOOL_AUDIT="passed"; [ "$SKIP_AUDIT" = "1" ] && TOOL_AUDIT="skipped"
node C:\\Dev\\_config\\skills\bin\abc-empirica.mjs --project-id OpenSprinkler-Weather postflight "$EMP_SESSION" <<EOF
{
  "summary": "abc cycle complete: SELECTED_ITEM",
  "vectors": { "completion": 1.0, "impact": 0.5 },
  "coverage": {
    "files": { "touched": $FILES_TOUCHED },
    "tools": { "vitest": "passed", "build": "passed", "audit": "$TOOL_AUDIT" },
    "gates": { "mechanical": "passed", "code_review": "passed", "epistemic": "$GATE_EPISTEMIC", "ci": "$GATE_CI" },
    "attempt": ATTEMPT_NUMBER
  },
  "reasoning": "Triple Gate passed; PM-VALIDATION posted (Step 5.8a, pre-postflight to avoid firewall lockout); post-push CI outcome recorded."
}
EOF
rm -f ".abc-state/emp-session-RUN_ID"
```

If the helper exits non-zero, log WARN but do NOT block — postflight failure is non-blocking per Empirica failure policy.

### Step 5.9a: Orchestrator self-verification (BLOCKING)

After PASS, the orchestrator independently verifies:

1. **Checklist item is actually checked**: `gh issue view ISSUE_NUM --json body --jq '.body'` contains `[x] SELECTED_ITEM` (use `grep -F --` to avoid regex surprises and prevent the leading checklist `-` from being parsed as an option).
2. **Commit exists on remote**: `git log origin/master --oneline -1` matches the local HEAD hash (or contains the same diff after a hook-driven hash rewrite).
3. **Commit message matches intent** (NON-BLOCKING WARN). Read `.abc-state/intended-msg-RUN_ID` and compare to `git log origin/master -1 --format=%s`. On mismatch, log a WARN that names both messages and the likely cause (pre-push hook absorbing staged work onto the previous commit — see the dc8174e2/606a80ed/bf76ee59/47665bfa cluster of 2026-05-23). Do NOT fail the cycle on mismatch — the code landed and CI is the truth; this is detection for a hook-class bug.

```bash
INTENDED_MSG=$(head -1 ".abc-state/intended-msg-RUN_ID" 2>/dev/null || echo "")
ACTUAL_MSG=$(git log origin/master -1 --format=%s 2>/dev/null || echo "")
if [ -n "$INTENDED_MSG" ] && [ "$INTENDED_MSG" != "$ACTUAL_MSG" ]; then
  echo "::warning:: Intended message != post-push commit message."
  echo "  intended: $INTENDED_MSG"
  echo "  actual:   $ACTUAL_MSG"
  echo "  Likely cause: pre-push hook absorbed staged work into HEAD (origin/master)."
fi
rm -f ".abc-state/intended-msg-RUN_ID"
```

If check 1 or 2 fails:
- Treat the cycle as FAILED — DO NOT increment `COMPLETED_CYCLES`.
- Increment `CONSECUTIVE_FAILURES` and `FAILED_CYCLES`.
- Trigger Step 6 retry once (re-invoke Phase B with the verification-failure context, then Step 5 with `ATTEMPT_NUMBER = 2`).
- Run the Step 7 failure-feedback loop (record in `.abc-failures.json`, auto-label `needs-decision` after 2 consecutive failures, log dead-end to Empirica, post `ABC-DIAGNOSTIC` comment).
- Close the Empirica transaction with FAIL postflight (`completion: 0.0`, `uncertainty: 0.55`) and `goals-complete --reason "FAILED: orchestrator self-verification — <which check> on attempt N/2"`.

### Step 5.9b: Complete Empirica goal (PASS path)

Read `GOAL_ID` from the per-cycle scratch file written in Step 3a-post (shell variables do not survive across orchestrator Bash tool calls). On a clean PASS path, close the goal and remove both scratch files so the cycle leaves no orphan state.

```bash
GOAL_ID=$(cat ".abc-state/goal-id-RUN_ID" 2>/dev/null || echo "")
COMMIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
if [ -n "$GOAL_ID" ]; then
  empirica goals-complete \
    --goal-id "$GOAL_ID" \
    --reason "Completed via /abc cycle: issue #ISSUE_NUM, commit $COMMIT_SHA, item: SELECTED_ITEM" \
    --output json 2>&1 | tail -3 || true
fi
rm -f ".abc-state/goal-id-RUN_ID" ".abc-state/subtask-id-RUN_ID" ".abc-state/budget-start-RUN_ID"
```

If `GOAL_ID` is empty (Phase A `goals-create` failed) the close is a no-op and the cleanup `rm -f` still succeeds. **Result: cycle PASS.** Continue to Step 5.9c.

### Step 5.9c: Accumulate the `[Unreleased]` bullet (PASS path, opt-in)

When `` is configured, compose ONE changelog bullet from this cycle's commit subject and append it to the session-local accumulator. This does NOT touch `CHANGELOG.md` (the per-cycle commit stays CHANGELOG-free, so the pre-push guard never engages); the accumulator is materialized into `[Unreleased]` only at bump time (STEP 7 / STEP 9). When the helper is empty, this is a complete no-op.

```bash
if [ -n "" ]; then
  # INTENDED_MSG was written to .abc-state/intended-msg-RUN_ID in Step 5.6; HEAD message is the fallback.
  RAW_MSG=$(head -1 ".abc-state/intended-msg-RUN_ID" 2>/dev/null || git log -1 --format=%s 2>/dev/null || echo "")
  # Strip the conventional-commit type(scope): prefix, then capitalize the first letter.
  BODY=$(printf '%s' "$RAW_MSG" | sed -E 's/^[a-z]+(\([^)]*\))?(!)?: //')
  BODY="$(printf '%s' "${BODY:0:1}" | tr '[:lower:]' '[:upper:]')${BODY:1}"
  # Ensure the issue ref is present.
  printf '%s' "$BODY" | grep -q "#ISSUE_NUM" || BODY="$BODY [#ISSUE_NUM]"
  # Append; de-dup so a re-run of Phase C in the same invocation doesn't double-add.
  ACC=".abc-state/unreleased-bullets"
  if [ -z "$BODY" ] || ! grep -qxF "- $BODY" "$ACC" 2>/dev/null; then
    [ -n "$BODY" ] && echo "- $BODY" >> "$ACC"
  fi
  echo "[version-bump] accumulated bullet: - $BODY  (acc has $(wc -l < "$ACC" 2>/dev/null | tr -d ' ') line(s))"
fi
```

**Result: cycle PASS.** Continue to Step 6.

---

### Step 5.10: FAIL path

Reached when any of: Gate 1 / Gate 2 / Gate 3 / Gate 5 / checkoff self-verify failed.

**Post PM-REJECTION:**

```bash
PM_REJECTION_FILE=".abc-state/pm-rejection-RUN_ID.md"
cat > "$PM_REJECTION_FILE" <<PM_REJECTION_EOF
<!-- octo:abc run=RUN_ID phase=pm-rejection issue=ISSUE_NUM -->
## PM-REJECTION

**Run:** RUN_ID
**Cycle:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Selected item:** SELECTED_ITEM
**Attempt:** ATTEMPT_NUMBER of 2
**Result:** FAIL

### Failed Gate
**$FAILED_GATE:** <what failed and why — pull from gate-specific log>
$([ \"$GATE_CI\" = \"failed\" ] || [ \"$GATE_CI\" = \"never_ran\" ] && printf '### Failed Gate\n**Gate 5 — Remote CI:** conclusion=%s; run=%s; failed_checks=%s\n' \"$CI_CONCLUSION\" \"$CI_RUN_URL\" \"$CI_FAILED_CHECKS\")

### Required Fixes
1. <specific fix>
2. <specific fix>

### Files to Review
- <path> — <what's wrong>
<!-- /octo:abc -->
PM_REJECTION_EOF
PM_REJECTION_URL=$(gh issue comment ISSUE_NUM --body-file "$PM_REJECTION_FILE" 2>/dev/null | tail -1)
```

**FAIL postflight** (critical — avoid the `Epistemic loop closed` Sentinel block on the next cycle):

```bash
EMP_SESSION=$(cat ".abc-state/emp-session-RUN_ID" 2>/dev/null || echo "")
if [ -n "$EMP_SESSION" ]; then
  FILES_TOUCHED=$(git diff --name-only HEAD 2>/dev/null | wc -l | tr -d ' ')
  node C:\\Dev\\_config\\skills\bin\abc-empirica.mjs --project-id OpenSprinkler-Weather postflight "$EMP_SESSION" <<EOF
{
  "summary": "abc cycle FAILED at $FAILED_GATE: SELECTED_ITEM",
  "vectors": { "completion": 0.0, "impact": 0.0, "uncertainty": 0.55, "change": 0.0 },
  "coverage": {
    "files": { "touched": $FILES_TOUCHED },
    "tools": { "vitest": "<passed|failed|skipped>", "build": "<passed|failed|skipped>", "audit": "<passed|failed|skipped>" },
    "gates": { "mechanical": "<passed|failed|skipped>", "code_review": "<passed|failed|skipped>", "epistemic": "<passed|failed|skipped>", "ci": "$GATE_CI" },
    "attempt": ATTEMPT_NUMBER,
    "failed_gate": "$FAILED_GATE (append run=$CI_RUN_URL when Gate 5 fails)"
  },
  "reasoning": "Step 5 $FAILED_GATE failed on attempt ATTEMPT_NUMBER/2. Closing transaction to keep the epistemic chain intact."
}
EOF
fi
```

**Close the Empirica goal as FAILED — only when the cycle is actually over.** The retry contract requires the goal to stay open across attempt 1 FAIL → Phase B retry → attempt 2 — so the close MUST be gated on `ATTEMPT_NUMBER == 2`. On attempt 1 FAIL, leave the goal open and the scratch file in place; Step 6 retry path will trigger the second attempt.

```bash
if [ "ATTEMPT_NUMBER" = "2" ]; then
  GOAL_ID=$(cat ".abc-state/goal-id-RUN_ID" 2>/dev/null || echo "")
  if [ -n "$GOAL_ID" ]; then
    empirica goals-complete --goal-id "$GOAL_ID" --reason "Abandoned via /abc cycle: issue #ISSUE_NUM, gate $FAILED_GATE failed on attempt 2/2 — see PM-REJECTION" --output json 2>&1 | tail -5 || true
  fi
  rm -f ".abc-state/goal-id-RUN_ID" ".abc-state/subtask-id-RUN_ID"
fi
```

**Result: cycle FAIL.** Continue to Step 6 retry decision.

---

## STEP 6: Retry Logic

- If PASS → Step 7.
- If FAIL and attempt 1:
  1. **Stash failed state** for forensics: `git stash push -m "abc-retry-$RUN_ID" -- ./`
  2. **Restore clean state**: `git checkout -- ./`
  3. Read `.claude/templates/abc-phase-b-retry.md`. Substitute placeholders.
  4. Re-invoke Codex with the retry prompt **using the same Codex invocation wrapper from STEP 4**. Do NOT inline a second `codex exec` command here; the STEP 4 wrapper is the single source of truth for model, reasoning effort, fast mode, working directory, and Codex `-c` config overrides.
  5. Re-invoke Phase C with `ATTEMPT_NUMBER = 2`.
- If FAIL and attempt 2 → Step 7 with failure.

---

## STEP 7: Cycle Output & Feedback Loops

**Wall-clock duration:** Before emitting the cycle output, compute elapsed seconds from STEP 0a's budget-start tmpfile. The helper is identical on PASS and FAIL paths:

```bash
BUDGET_START=$(cat ".abc-state/budget-start-$RUN_ID" 2>/dev/null || echo "")
if [ -n "$BUDGET_START" ]; then
  ELAPSED_SEC=$(( $(date +%s) - BUDGET_START ))
  ELAPSED_HUMAN=$(printf "%dm %02ds" $((ELAPSED_SEC / 60)) $((ELAPSED_SEC % 60)))
else
  ELAPSED_HUMAN="(unknown — budget-start tmpfile missing)"
fi
```

### On Success
```
--- /abc #ISSUE_NUM — PASS (run: RUN_ID, cycle: $ELAPSED_HUMAN) ---
Item: <selected item text>
Commit: <hash> — <commit message>
Next: <next unchecked item or "All items complete">
Issue: https://github.com/kars85/OpenSprinkler-Weather/issues/ISSUE_NUM
```

### Step 7a: Version bump — single-mode invocation end (opt-in)

`/abc <issue>` (single mode) is a one-cycle invocation, so the per-`/abc`-invocation patch bump fires HERE, after the PASS output. In `--loopall` and `--loop`, the bump is deferred to STEP 9 (end of loop) — do NOT run it here for those modes, or you'd bump once per cycle.

Run ONLY when: `MODE = single` AND `` is non-empty AND the cycle PASSED. Empty helper → complete no-op (today's behavior).

```bash
if [ "MODE" = "single" ] && [ -n "" ] && [ -s ".abc-state/unreleased-bullets" ]; then
  echo "=== Step 7a: per-/abc version bump (single mode) ==="
  BUMP_RESULT=$( --bullets-file .abc-state/unreleased-bullets --mode single --output json 2>&1)
  BUMP_RC=$?
  BUMP_VERSION=$(echo "$BUMP_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=d.indexOf('{'),e=d.lastIndexOf('}');try{const j=JSON.parse(d.slice(s,e+1));process.stdout.write((j.version||'')+(j.pushed?' (pushed)':''));}catch(x){}})")
  if [ $BUMP_RC -eq 0 ]; then
    echo "[version-bump] released ${BUMP_VERSION:-?}; accumulator cleared by helper."
    rm -f .abc-state/unreleased-bullets   # belt-and-suspenders; helper should clear on success
  else
    echo "::warning:: [version-bump] bump failed (rc=$BUMP_RC) — NON-BLOCKING; the cycle already shipped + CI is green. Re-run the helper manually. Output:"
    echo "$BUMP_RESULT" | tail -10
  fi
fi
```

> **NON-BLOCKING:** a bump failure never retroactively fails the cycle — the code already landed on `origin/master` and passed CI. Surface the warning and move on. The accumulator persists on failure so a manual re-run can still ship the version.

### On Failure (after retry)

```
--- /abc #ISSUE_NUM — FAIL (run: RUN_ID, cycle: $ELAPSED_HUMAN, 2 attempts) ---
Item: <selected item text>
Failed gate: <gate name> — <reason>
Manual intervention required.
```

**Failure feedback loop (auto-label + record + Empirica):**

1. **Record failure** in `.abc-failures.json`:
   ```bash
   node -e "
     const fs = require('fs');
     const p = '.abc-failures.json';
     const d = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf-8')) : {};
     const k = String(ISSUE_NUM);
     if (!d[k]) d[k] = { consecutive: 0, total: 0, lastGate: '', lastRun: '' };
     d[k].consecutive += 1;
     d[k].total += 1;
     d[k].lastGate = 'GATE_NAME';
     d[k].lastRun = 'RUN_ID';
     fs.writeFileSync(p, JSON.stringify(d, null, 2));
   "
   ```

2. **Auto-label** when consecutive failures ≥ 2:
   ```bash
   gh issue edit ISSUE_NUM --add-label "needs-decision"
   ```

3. **Log dead-end** to Empirica (1.9.0+: provenance flags + optional artifact edge to the goal). Read `GOAL_ID` from the per-cycle scratch file (Step 3a-post wrote it; the orchestrator's shell variable is not preserved across Bash tool calls):
   ```bash
   GOAL_ID=$(cat ".abc-state/goal-id-$RUN_ID" 2>/dev/null || echo "")
   FILES_TOUCHED_TOTAL=$(git diff --name-only HEAD~2..HEAD 2>/dev/null | sort -u | wc -l | tr -d ' ')
   DEADEND_DESC=$(cat <<DESC_EOF
## Postmortem — #ISSUE_NUM / SELECTED_ITEM (run RUN_ID)

**Failed gate:** GATE_NAME
**Attempts:** 2 (both exhausted)
**Reason:** FAILURE_REASON
**Files touched across both attempts:** $FILES_TOUCHED_TOTAL

Both Codex passes failed at the same gate. Auto-applied \`needs-decision\` label. See \`ABC-DIAGNOSTIC\` issue comment for the full failure trace and suggested next steps.
DESC_EOF
)
   DEADEND_ARGS=( --approach "abc Phase B/C for #ISSUE_NUM item: SELECTED_ITEM"
                  --why-failed "GATE_NAME failed on both attempts: FAILURE_REASON"
                  --description "$DEADEND_DESC"
                  --source "https://github.com/kars85/OpenSprinkler-Weather/issues/ISSUE_NUM"
                  --epistemic-source mixed
                  --visibility local
                  --project-id OpenSprinkler-Weather )
   [ -n "$GOAL_ID" ] && DEADEND_ARGS+=( --related-to "$GOAL_ID" )
   DEADEND_RESPONSE=$(empirica deadend-log "${DEADEND_ARGS[@]}" --output json 2>/dev/null || echo '{}')
   SUGGESTED_LINKS=$(echo "$DEADEND_RESPONSE" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const links=(j.suggested_links||[]).slice(0,3).map(l=>'- '+(l.kind||'artifact')+': '+(l.title||'(untitled)')+(l.id?' ('+String(l.id).slice(0,8)+')':'')).join('\\n');process.stdout.write(links);}catch(e){}})")
   ```

3b. **Close the Empirica transaction (FAIL postflight) and goal.** The Phase C template already does this on the inner FAIL branch; this step is a belt-and-suspenders catch for the retry-exhaustion path so an orphaned `goals_in_progress` cannot accumulate. Skip if Phase C already ran the FAIL postflight (idempotent — postflight on a closed transaction is a no-op WARN).

   The retry-exhaustion postflight includes a `coverage` block (Empirica 1.8.18+) that records the file scope of the second attempt's working tree, the failed gate, and a free-form `attempts` key surfacing that both retries were consumed. `previous_transaction_feedback` on the next cycle's preflight will carry this signal so the orchestrator (and any human reviewing `--loopall` traces) can see at a glance which issues are repeat offenders.

   ```bash
   EMP_SESSION=$(cat ".abc-state/emp-session-$RUN_ID" 2>/dev/null || echo "")
   if [ -n "$EMP_SESSION" ]; then
     FILES_TOUCHED=$(git diff --name-only HEAD 2>/dev/null | wc -l | tr -d ' ')
     POSTFLIGHT_RESPONSE=$($EMPIRICA_HELPER postflight "$EMP_SESSION" <<EOF
   {
     "summary": "abc cycle EXHAUSTED retries on #ISSUE_NUM item: SELECTED_ITEM",
     "vectors": { "completion": 0.0, "impact": 0.0, "uncertainty": 0.6, "change": 0.0 },
     "coverage": {
       "files": { "touched": $FILES_TOUCHED },
       "attempts": { "total": 2, "outcome": "exhausted" },
       "failed_gate": "GATE_NAME"
     },
     "reasoning": "Both Phase B attempts failed at GATE_NAME. Closing the transaction so the next cycle's preflight starts cleanly."
   }
   EOF
   )
     # Surface deferred-proposals nudge (1.9.9+) if the postflight response carries one.
     # Field may be a string ("N deferred proposals: ...") or {items:[{objective,...}]}.
     # Non-blocking: malformed/missing → silent no-op.
     DEFERRED_NOTE=$(echo "$POSTFLIGHT_RESPONSE" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const n=j.deferred_proposals_note;if(!n)return;if(typeof n==='string'){process.stdout.write(n);return;}if(n.items&&n.items.length){process.stdout.write('Deferred proposals ('+Math.min(10,n.items.length)+'):\\n'+n.items.slice(0,10).map(i=>'  - '+(i.objective||i.title||'(unnamed)')).join('\\n'));}}catch(e){}})" 2>/dev/null)
     [ -n "$DEFERRED_NOTE" ] && echo "$DEFERRED_NOTE"
   fi
   GOAL_ID=$(cat ".abc-state/goal-id-$RUN_ID" 2>/dev/null || echo "")
   if [ -n "$GOAL_ID" ]; then
     empirica goals-complete --goal-id "$GOAL_ID" --reason "Abandoned via /abc cycle: issue #ISSUE_NUM, gate GATE_NAME failed on both attempts; see ABC-DIAGNOSTIC" --output json 2>&1 | tail -3 || true
   fi
   rm -f ".abc-state/emp-session-$RUN_ID" ".abc-state/goal-id-$RUN_ID" ".abc-state/subtask-id-$RUN_ID" ".abc-state/budget-start-$RUN_ID"  # cleanup per-cycle scratch files
   ```

4. **Post diagnostic comment** on the issue:
   ```bash
   gh issue comment ISSUE_NUM --body "## ABC-DIAGNOSTIC (run: RUN_ID)
   **Item:** SELECTED_ITEM
   **Gate:** GATE_NAME
   **Attempts:** 2
   **Failure reason:** FAILURE_REASON
   **Action:** \`needs-decision\` label applied. Issue deprioritized in triage until manual review.

   **Related artifacts (Empirica suggested):**
   ${SUGGESTED_LINKS:-_(none)_}"
   ```

### On Success — Reset Failure Counter

After a PASS, clear the consecutive counter for this issue:
```bash
node -e "
  const fs = require('fs');
  const p = '.abc-failures.json';
  if (!fs.existsSync(p)) process.exit(0);
  const d = JSON.parse(fs.readFileSync(p,'utf-8'));
  const k = String(ISSUE_NUM);
  if (d[k]) { d[k].consecutive = 0; fs.writeFileSync(p, JSON.stringify(d, null, 2)); }
"
```

---

## STEP 7b: Calibration Auto-Update (Every 20 Cycles)

After incrementing `COMPLETED_CYCLES`, check if `(COMPLETED_CYCLES + FAILED_CYCLES) % 20 === 0`. If true, run calibration:

```bash
node -e "
  const fs = require('fs');
  const fp = '.abc-failures.json';
  const wp = '.abc-weights.json';
  const failures = fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp,'utf-8')) : {};
  const weights = JSON.parse(fs.readFileSync(wp,'utf-8'));

  // Count pass/fail rates by label from last 20 cycles (approximated by failure records)
  const highFailIssues = Object.values(failures).filter(f => f.total >= 2);
  const totalIssues = Object.keys(failures).length || 1;
  const failRate = highFailIssues.length / totalIssues;

  // If fail rate > 40%, increase effort penalties (system is over-reaching)
  if (failRate > 0.4) {
    weights.effort.L = Math.max(weights.effort.L - 5, -20);
    weights.effort.S = Math.max(weights.effort.S - 2, -5);
  }
  // If fail rate < 15%, relax effort penalties (system can handle harder work)
  if (failRate < 0.15) {
    weights.effort.L = Math.min(weights.effort.L + 3, 0);
    weights.effort.S = Math.min(weights.effort.S + 2, 10);
  }

  // Increase cooldown penalty if repeated failures cluster
  const maxConsec = Math.max(...Object.values(failures).map(f => f.consecutive), 0);
  if (maxConsec >= 3) {
    weights.penalties['consecutive-failure-cooldown'] = Math.max(
      weights.penalties['consecutive-failure-cooldown'] - 5, -50
    );
  }

  weights.meta.last_updated = new Date().toISOString().slice(0,10);
  weights.meta.observations += 20;
  fs.writeFileSync(wp, JSON.stringify(weights, null, 2));
  console.log('Calibration updated: failRate=' + failRate.toFixed(2) + ', observations=' + weights.meta.observations);
"
```

Post calibration result to Empirica:
```bash
empirica finding-log \
  --finding "abc calibration updated at cycle $(( COMPLETED_CYCLES + FAILED_CYCLES )): fail rate RATE, weights adjusted" \
  --impact 0.3 \
  --source ".abc-failures.json" \
  --source ".abc-weights.json" \
  --epistemic-source mixed \
  --project-id OpenSprinkler-Weather
```

---

## STEP 8: Loop Continuation

### 8a. Update Counters
- PASS: `COMPLETED_CYCLES += 1`, `CONSECUTIVE_FAILURES = 0`
- FAIL: `FAILED_CYCLES += 1`, `CONSECUTIVE_FAILURES += 1`

### 8b. Blocker Resolution Check

After success, check if the completed item unblocks other issues:
```bash
rtk gh issue list --state open --label "blocked" --limit 50 --json number,body --jq \
  '[.[] | select(.body | test("blocked by #ISSUE_NUM"; "i")) | .number]'
```
Remove `blocked` label from unblocked issues.

### 8c. Empirica ↔ GitHub Bidirectional Sync

After each cycle, sync state between Empirica and GitHub:

**Empirica → GitHub (high context gap → label):**
If the helper gap check (`$EMPIRICA_HELPER gap`, see 8d below) reveals `context` gap > 0.18 (approaching 0.2 threshold):
```bash
gh issue edit ISSUE_NUM --add-label "needs-investigation"
gh issue comment ISSUE_NUM --body "## ABC-EPISTEMIC-ALERT (run: RUN_ID)
Context gap is X.XX (threshold: 0.2). This issue may have hidden complexity.
Pausing automated work until investigation reduces uncertainty."
```

**GitHub → Empirica (external close → goal-complete):**
Before re-triage, check if the current issue was closed externally (by a human or another workflow). Read `GOAL_ID` from the per-cycle scratch file (the orchestrator's shell variable from Step 3a-post is gone by this point):
```bash
ISSUE_STATE=$(gh issue view ISSUE_NUM --json state --jq .state)
if [ "$ISSUE_STATE" = "CLOSED" ]; then
  GOAL_ID=$(cat ".abc-state/goal-id-$RUN_ID" 2>/dev/null || echo "")
  if [ -n "$GOAL_ID" ]; then
    empirica goals-complete --goal-id "$GOAL_ID" --reason "Issue #ISSUE_NUM closed externally during /abc cycle" --output json 2>&1 | tail -3 || true
  fi
  rm -f ".abc-state/goal-id-$RUN_ID" ".abc-state/subtask-id-$RUN_ID" ".abc-state/budget-start-$RUN_ID"
fi
```

**Dead-end → GitHub (diagnostic comment):**
Already handled in Step 7 failure path. The `empirica deadend-log` + `gh issue comment` pair ensures both systems record the failure.

**Goal-state drift surfacing (1.9.0+):**
Once per cycle, surface any goals where status text disagrees with `is_completed`. This catches half-closed goals from prior cycles that would otherwise pollute calibration:
```bash
empirica goals-list --status drift --project-id OpenSprinkler-Weather --limit 5 --output json 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);if(j.drift_count>0)console.log('  goal-drift:',j.drift_count,'rows -',j.drift_hint||'');}catch(e){}})"
```
Non-blocking: empirica failure or zero drift → silent no-op. Drift > 0 → printed to the loop progress line.

### 8c.5. End-of-Issue CI Gate (opt-in — defer-to-issue-end; runs BEFORE stop conditions)

**Gate:** Runs only when `false` is `true`, a CI-wait helper is configured, AND issue #ISSUE_NUM has just become fully checked (no `- [ ]` lines remain). When defer is off (default), this section is skipped entirely — per-cycle Gate 5 already verified each commit.

**Why this runs before 8d (stop conditions):** 8d's stop checks include "no unchecked items remain," which fires the moment an issue's last item is checked — *including the loop's final issue*. If this gate ran after 8d (or after 8e), that terminal completion would terminate the loop before the issue's deferred CI ever ran, shipping the issue's items with remote CI never executed and the issue never closed by the gate. Running here guarantees a just-completed issue is always verified + closed (or routed to CI-RED-REMEDIATION) before any stop decision.

This is the **single remote-CI checkpoint for the whole issue**. The per-cycle pushes shipped on the local Triple Gate alone (Gate 5 was `deferred`), so here the orchestrator runs the full local coverage suite + the remote CI on HEAD before the issue is allowed to close. A red result drives the CI-RED-REMEDIATION control loop instead of closing — the checklist is the red→green control plane.

```bash
RUN_ID=$(ls -t .abc-state/emp-session-* 2>/dev/null | head -1 | sed 's|.*emp-session-||')
UNCHECKED=$(gh issue view ISSUE_NUM --json body --jq '.body' | grep -c -- "- \[ \]" || true)
if [ "false" = "true" ] && [ -n "" ] && [ "$UNCHECKED" = "0" ]; then
  echo "=== STEP 8c.5: end-of-issue CI gate for #ISSUE_NUM ==="
  REPO_DIR=$(node -e "process.stdout.write(process.argv[1].replace(/\\\\/g,'/'))" "C:\Dev\OpenSprinkler-Weather")
  APP_DIR_BASH=$(node -e "process.stdout.write(process.argv[1].replace(/\\\\/g,'/'))" "C:\Dev\OpenSprinkler-Weather")

  # 1) Full local coverage + build (per-cycle Gate 1 used the fast changed-files set).
  cd "$APP_DIR_BASH"
  ISSUE_GATE_LOCAL=0
  ( npm test ) > "$TMPDIR/issue-end-coverage.log" 2>&1 || ISSUE_GATE_LOCAL=1
  ( npm run compile )         > "$TMPDIR/issue-end-build.log"    2>&1 || ISSUE_GATE_LOCAL=1
  cd "$REPO_DIR"

  # 2) Remote CI on HEAD (full required checks — the work the per-cycle pushes deferred).
  ISSUE_END_SHA=$(git rev-parse HEAD)
  CI_RESULT=$( \
    --commit-sha "$ISSUE_END_SHA" \
    --required-checks "" \
    --timeout-sec 1800 \
    --output json 2>&1)
  CI_RC=$?
  CI_RUN_URL=$(echo "$CI_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.run_url||'');}catch(e){}})")
  CI_CONCLUSION=$(echo "$CI_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.conclusion||'unknown');}catch(e){process.stdout.write('unknown');}})")
  CI_FAILED_CHECKS=$(echo "$CI_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const f=(j.checks&&j.checks.failed)||[];process.stdout.write(f.join(','));}catch(e){}})")

  if [ "$ISSUE_GATE_LOCAL" = "0" ] && [ $CI_RC -eq 0 ]; then
    # GREEN — close the issue and clear per-issue state.
    gh issue close ISSUE_NUM --comment "End-of-issue CI gate PASS on $ISSUE_END_SHA (run RUN_ID). Required checks green: . CI: $CI_RUN_URL"
    rm -f ".abc-state/batch-plan-ISSUE_NUM.json"
    echo "[issue-end-ci] #ISSUE_NUM closed — CI green."
  else
    # RED — control-plane remediation: keep the issue OPEN, append a P0 remediation item.
    FAIL_SRC=$([ "$ISSUE_GATE_LOCAL" != "0" ] && echo "local coverage/build" || echo "remote CI")
    ISSUE_COMMITS=$(git log --oneline --grep="#ISSUE_NUM" -n 20 2>/dev/null || echo "(none)")
    REMEDIATION_FILE=".abc-state/ci-red-remediation-RUN_ID.md"
    cat > "$REMEDIATION_FILE" <<REMEDIATION_EOF
<!-- octo:abc run=RUN_ID phase=ci-red-remediation issue=ISSUE_NUM -->
## CI-RED-REMEDIATION

**Run:** RUN_ID
**End-of-issue CI:** FAIL ($FAIL_SRC)
**Commit:** $ISSUE_END_SHA
**Conclusion:** $CI_CONCLUSION
**Failed checks:** $CI_FAILED_CHECKS
**CI run:** $CI_RUN_URL

All checklist items checked off on the per-cycle local gate, but the consolidated
end-of-issue CI is red. The issue stays OPEN and a \`[P0]\` remediation item has been
appended so the next /abc cycle drives red → green. Candidate commits (this issue):

\`\`\`
$ISSUE_COMMITS
\`\`\`
<!-- /octo:abc -->
REMEDIATION_EOF
    gh issue comment ISSUE_NUM --body-file "$REMEDIATION_FILE"

    # Append the remediation checklist item so the loop has work to select next.
    CUR_BODY=$(gh issue view ISSUE_NUM --json body --jq '.body')
    printf '%s\n- [ ] [P0] CI remediation (run RUN_ID): fix failing checks [%s] — see CI-RED-REMEDIATION\n' \
      "$CUR_BODY" "$CI_FAILED_CHECKS" > "$TMPDIR/issue-body-ISSUE_NUM.md"
    gh issue edit ISSUE_NUM --body-file "$TMPDIR/issue-body-ISSUE_NUM.md"
    gh issue edit ISSUE_NUM --add-label "needs-decision"
    rm -f ".abc-state/batch-plan-ISSUE_NUM.json"   # body changed → STEP 1.5 re-plans incl. the remediation item
    echo "[issue-end-ci] #ISSUE_NUM RED ($FAIL_SRC) — remediation item appended, issue kept open."
  fi
fi
```

**Outcome routing:** GREEN → issue closed; 8d then sees it gone and re-triages/stops cleanly. RED → issue stays open with a fresh `[P0]` remediation item; 8f keeps the loop on it and selects the remediation item next cycle. Either way the loop never stalls, and the gate has already run before any stop decision.

### 8d. Check Stop Conditions (see table in Step 1e)

For epistemic drift checks between cycles, use the minimal command (reads vectors only, skips full project rediscovery):
```bash
$EMPIRICA_CMD_MINIMAL
```

For a quick context-gap stop-condition check (returns JSON with `status: OK|WARN|REJECT`):
```bash
$EMPIRICA_HELPER gap
```
This is the preferred check on Windows — it avoids `jq` quoting hazards entirely.

### 8e. Context Checkpoint (loopall only)

After every `CHECKPOINT_EVERY` completed cycles (default 5), emit a `CONTEXT CHECKPOINT` marker so the operator can `/clear` the in-conversation context and reclaim tokens. Empirica state, `.abc-failures.json`, `.abc-weights.json`, and GitHub issue state all persist across `/clear`; only the in-conversation orchestrator state (mostly cumulative subagent summaries) needs the reset to recover tokens.

`empirica session-snapshot` is called to preserve a recoverable handle to the current epistemic state. The snapshot ID surfaces in the marker so audits can trace from the post-checkpoint resume back to the pre-checkpoint state.

```bash
if [ "$MODE" = "loopall" ] && [ "${CHECKPOINT_EVERY:-5}" -gt 0 ] && [ "$COMPLETED_CYCLES" -gt 0 ] && [ $((COMPLETED_CYCLES % ${CHECKPOINT_EVERY:-5})) -eq 0 ]; then
  EMP_SESSION_FOR_SNAPSHOT=$(cat ".abc-state/emp-session-$RUN_ID" 2>/dev/null || echo "")
  SNAPSHOT_ID=""
  if [ -n "$EMP_SESSION_FOR_SNAPSHOT" ]; then
    SNAPSHOT_RESPONSE=$(empirica session-snapshot --session-id "$EMP_SESSION_FOR_SNAPSHOT" --output json 2>/dev/null || echo '{}')
    SNAPSHOT_ID=$(echo "$SNAPSHOT_RESPONSE" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j.snapshot_id||j.id||'');}catch(e){}})" 2>/dev/null)
  fi
  OPEN_REMAINING=$(rtk gh issue list --state open --limit 200 --json number --jq '. | length' 2>/dev/null || echo "?")
  RESUME_CMD="/abc --loopall --checkpoint-every ${CHECKPOINT_EVERY:-5}"
  [ -n "$EPIC_FILTER" ] && RESUME_CMD="$RESUME_CMD --epic $EPIC_FILTER"
  [ -n "$CAMPAIGN_FILTER" ] && RESUME_CMD="$RESUME_CMD --campaign $CAMPAIGN_FILTER"
  [ -n "$MAX_CYCLES" ] && RESUME_CMD="$RESUME_CMD --max-cycles $((MAX_CYCLES - COMPLETED_CYCLES))"
  cat <<MARKER

=== CONTEXT CHECKPOINT (cycle $COMPLETED_CYCLES) ===
completed: $COMPLETED_CYCLES | failed: $FAILED_CYCLES | open issues remaining: $OPEN_REMAINING
snapshot: ${SNAPSHOT_ID:-_(not captured)_}

Safe to /clear context for token savings:
  1. Type /clear in Claude Code
  2. Re-run: $RESUME_CMD

Persistent across /clear: calibration ($STATE_WEIGHTS), failure counts ($STATE_FAILURES),
Empirica artifacts (project DB), GitHub issue/label state. Only in-conversation
orchestrator summaries are dropped — those are the dominant cost in --loopall.

Continuing without /clear is also fine — this marker is informational.
=== END CHECKPOINT ===

MARKER
fi
```

The marker is non-blocking: the orchestrator continues into Step 8f re-triage regardless. Operators who want hard-pause behavior wrap the invocation externally (e.g., a CI step that greps stdout for `=== CONTEXT CHECKPOINT` and re-spawns the next batch in a fresh process).

> **Future optimization (TODO):** Overlap next cycle's triage/Phase A with current cycle's git push for wall-time savings. Not implemented yet to keep orchestrator simple.

> **End-of-issue CI gate moved to STEP 8c.5.** It must run *before* the 8d stop-condition check — otherwise a terminal issue completion (the "no unchecked items remain" stop) would end the loop before the issue's deferred CI ran. See 8c.5 above for the full gate.

### 8f. Re-Triage and Continue

1. Current issue has more unchecked items → stay on it (skip triage)
2. Issue fully checked → the end-of-issue CI gate already ran at STEP 8c.5 (before the 8d stop check), so a green issue is already closed; re-triage via STEP 1. RED issues stayed open with a `[P0]` remediation item — stay on the issue and work it. (When defer is off, behavior is unchanged from prior.)
3. New `RUN_ID` → STEP 2

**Loopall additional rules:**
- NO voluntary pauses. Only hard stop conditions terminate.
- Refresh qualitative cache every 10 cycles.
- Re-triage after every issue close (full repo-wide ranking).
- Progress output mandatory between cycles.

---

## STEP 9: Final Summary (Loop Modes)

**Deferred-CI exit backstop (`false=true` only):** STEP 8c.5 verifies + closes each issue the moment it completes (before any stop decision), so a loop that ends by running out of work leaves no unverified issue. The one residual case is a loop that exits via **circuit breaker or epistemic kill while an issue is still IN PROGRESS** — its checked items shipped on the local gate with remote CI deferred, and 8c.5 has not run (the issue isn't complete). When that happens, the Final Summary MUST surface it: name the in-progress issue and state that its deferred commits are NOT remote-CI-verified, and that resuming the loop (which will reach 8c.5 on completion) or running `` manually on HEAD is required to verify them. Non-blocking, but never silent — an unverified in-progress issue must not look done.

### Step 9.0: Version bump — end-of-loop (opt-in)

In `--loop` / `--loopall`, the per-`/abc`-invocation patch bump fires ONCE here, at loop termination (any stop condition: no work left, MAX_CYCLES, circuit breaker, epistemic kill), AFTER the last cycle's Phase C. `[Unreleased]` has accumulated every passed cycle's bullet (Step 5.9c), so the loop ships as a single coherent version. Run ONLY when `` is non-empty AND the accumulator has content (≥1 cycle passed). Empty helper or empty accumulator (all cycles failed) → no-op.

```bash
if [ -n "" ] && [ -s ".abc-state/unreleased-bullets" ]; then
  echo "=== Step 9.0: end-of-loop version bump ($(wc -l < .abc-state/unreleased-bullets | tr -d ' ') bullet(s)) ==="
  BUMP_RESULT=$( --bullets-file .abc-state/unreleased-bullets --mode loopall --output json 2>&1)
  BUMP_RC=$?
  BUMP_VERSION=$(echo "$BUMP_RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=d.indexOf('{'),e=d.lastIndexOf('}');try{const j=JSON.parse(d.slice(s,e+1));process.stdout.write((j.version||'')+(j.pushed?' (pushed)':''));}catch(x){}})")
  if [ $BUMP_RC -eq 0 ]; then
    echo "[version-bump] released ${BUMP_VERSION:-?} for the loop; accumulator cleared."
    rm -f .abc-state/unreleased-bullets
  else
    echo "::warning:: [version-bump] end-of-loop bump failed (rc=$BUMP_RC) — NON-BLOCKING; all cycles already shipped + passed CI. Re-run the helper manually. Output:"
    echo "$BUMP_RESULT" | tail -10
  fi
fi
```

> Surface `${BUMP_VERSION}` in the Final Summary below (a `### Released` line) when a bump ran. NON-BLOCKING on failure, same rationale as Step 7a.

```
=== /abc Loop Complete ===

Cycles: X completed, Y failed
Stop reason: <reason>

### Completed Items
| Cycle | Issue | Item | Commit |
|-------|-------|------|--------|

### Failed Items
| Cycle | Issue | Item | Gate | Reason |
|-------|-------|------|------|--------|

### Unblocked Issues
- #N — unblocked by completing #M

### Remaining Top-Priority Issues
| Issue | Title | Score |
|-------|-------|-------|

### Empirica Drift
| Vector | Start | End | Delta |
|--------|-------|-----|-------|
```
# Closeout invariants

These invariants are part of the canonical `/abc` contract and apply to every
phase/step expansion:

- Treat Empirica `postflight` as the terminal mutation boundary for the active
  cycle. After Gate 4 postflight succeeds, run only read-only verification and
  final reporting.
- Complete all mutable repo, GitHub, release-bookkeeping, changelog/version
  bump, checklist, and Empirica goal/finding operations before Gate 4 postflight.
- Do not open a second Empirica `preflight` as normal closeout behavior. A fresh
  transaction is valid only as an explicit manual recovery action after a failed
  or interrupted closeout.
- Do not depend on transient shell scratch files such as `/tmp/abc-emp-session-*`
  for required closeout state. Carry session IDs from structured helper output,
  deterministic repo-local state such as `.abc-state/`, or explicit command
  arguments.
- When invoking Empirica commands with version-sensitive flags, probe or retry
  through a compatibility path. In particular, if `goals-complete --project-id`
  is rejected by the installed CLI, retry once without `--project-id` and record
  the contract drift in the closeout notes.
- On Windows, avoid Bash-only closeout fragments (`/tmp`, `sed`, heredoc-only
  command shapes) for required mutations. Use project helpers or explicit
  Windows-compatible commands.

# Latency control contract

The `/abc` workflow must preserve acceptance rigor while avoiding repeated
ceremony. Apply these rules for every checklist item:

## 1. Simple item fast path

Use the simple-item fast path when all of the following are true:

- The selected checklist item has narrow scope.
- The change touches at most two implementation files plus directly related
  tests/docs/config.
- The change does not modify authentication, authorization, secrets,
  database/schema/migration behavior, provider routing, ingestion semantics,
  compliance semantics, payment/billing, deployment, CI configuration, or shared
  framework utilities.
- The GitHub issue acceptance criteria do not explicitly require broad
  validation.

Simple-item fast path order:

1. Select exactly one unchecked checklist item.
2. Read only the issue body, current session mirror if present, directly
   relevant files, and local helper configuration needed for that item.
3. Implement the item.
4. Run focused verification selected from the changed-file risk matrix.
5. Run mechanical closeout: checklist checkoff, commit/push, self-verification,
   release bookkeeping if configured, Empirica finding/goal writes, then Gate 4
   postflight.
6. Report the focused evidence and any explicitly skipped gates with structured
   skip reasons.

Do not use the simple-item fast path if risk classification is uncertain. Fall
back to the full path.

## 2. Incremental context discovery

Do not rediscover stable context repeatedly inside one `/abc` cycle. Cache stable
facts at cycle start and refresh only facts that can plausibly change during the
cycle:

- Refresh each time: GitHub issue body/checklist, git status, changed files,
  pushed commit, CI run URL/result, and helper command outcomes.
- Reuse within the cycle unless scope changes: project identity, helper paths,
  workflow profile, Empirica project registration, static acceptance text,
  dependency map, and previously read unchanged source files.

If new evidence expands scope, invalidate only the affected cached facts instead
of restarting broad discovery.

## 3. Bounded Empirica usage

Use Empirica as awareness and epistemic-confidence input, not as repeated
ceremony:

- Open one preflight transaction per `/abc` cycle.
- Run at least one task-relevant retrieval/logging phase when Empirica is
  available and required by the project contract.
- Add further Empirica calls only when scope changes, confidence is unsafe, or a
  gate outcome needs explicit epistemic evidence.
- Close with one terminal Gate 4 postflight.

Do not open a second preflight for normal closeout.

## 4. Changed-file risk matrix

Choose the narrowest verification that defends the changed behavior:

- `web/next.config.*`, package/build config, or framework config: run a config
  or build smoke check plus any relevant lint/type check.
- Pure library/parser/compliance logic: run targeted unit tests for the changed
  module and adjacent regression fixtures.
- API routes, server actions, auth/session, data access, provider routing, or
  ingestion pipelines: run focused unit/integration tests and broaden to route
  or workflow tests when contracts cross module boundaries.
- React UI components/pages: run focused component/unit tests when present;
  run focused Playwright only for user-visible workflow or layout behavior.
- Schema, migration, security-sensitive, deployment, CI, or shared utility
  changes: use the full validation path unless the issue defines a narrower
  acceptance gate.
- Docs-only or prompt-only changes: run render/parity/contract checks when
  available; otherwise perform deterministic text inspection and skip code tests
  with a structured reason.

When no matching focused test exists, run the nearest deterministic check and
record the test gap.

## 5. Asynchronous CI wait

After pushing, capture the CI run URL and poll through the configured lightweight
helper. Fail fast if the expected workflow does not queue within the configured
timeout. Do not perform broad additional local validation while waiting unless it
directly addresses the selected item or a failed gate.

Gate 5 remains mandatory when the project config declares a CI-wait helper.

## 6. Helper-driven mechanical closeout

Use deterministic helpers for mechanical closeout whenever they are configured:

- checklist checkoff
- PM validation comment creation
- commit-message and remote-HEAD self-verification
- changelog/release-note accumulation
- version bump
- CI polling
- Empirica preflight/postflight wrappers

Reserve sub-agent or long-form review hops for judgment-heavy risk evaluation,
not for deterministic bookkeeping.

## 7. Structured skip reasons

Every skipped gate must emit a concise structured skip record in the final
evidence:

```json
{ "gate": "full-playwright", "decision": "skipped", "reason": "no UI files changed" }
```

Skipped gates are acceptable only when the changed-file risk matrix and issue
acceptance criteria justify the decision.

## 8. Shell-light bookkeeping

Prefer project helpers with JSON input/output for closeout bookkeeping. Avoid
required mutation logic embedded in ad hoc shell pipelines. On Windows, do not
depend on Bash-only constructs such as `/tmp`, `sed`, process substitution, or
heredoc-only command shapes for required state changes.

## 9. No postflight recovery churn

A successful Gate 4 postflight ends mutable work for the cycle. Do not run normal
recovery, release bookkeeping, second preflight, or extra Empirica mutation after
successful postflight. If closeout work remains, the workflow order is wrong:
perform that work before postflight in the next corrected run.
