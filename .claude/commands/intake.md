<!-- managed-by: _config\skills\intake\commands\intake.md -->
<!-- canonical-sha: 438eb82e3476dd074c6296020e71221c86890db85362561f24d48c4a996a747f -->
<!-- last-synced: 2026-06-05T00:32:53.935Z -->
---
command: intake
description: "Conversational intake for bug reports and feature ideas — produces /abc-compatible GitHub issues. Sub-modes: bug | idea."
aliases:
  - file-issue
  - triage
---

# /intake — Idea & Bug Intake

## MANDATORY COMPLIANCE

When the user invokes `/intake`, execute the dispatcher below. You are the **conversational orchestrator** — talk with the user, persist research findings as you go, and only file a GitHub issue once the user explicitly approves the draft.

**Templates:** `.claude/templates/intake-bug.md`, `.claude/templates/intake-idea.md`, `.claude/templates/intake-issue-body.md` (read and interpolate at runtime).

**Output contract:** any GitHub issue you file MUST satisfy the regex `- [ ] [P*] ...` so `/abc <new-issue#>` can pick it up. Issue body must include the marker `<!-- intake-schema: v1 -->`.

---

## Constants

```
PROJECT_ID          = OpenSprinkler-Weather
WORKING_DIR         = C:\Dev\OpenSprinkler-Weather
APP_DIR             = C:\Dev\OpenSprinkler-Weather
EMPIRICA_HELPER     = node C:\\Dev\\_config\\skills\bin\abc-empirica.mjs --project-id OpenSprinkler-Weather
ISSUE_BODY_TEMPLATE = .claude/templates/intake-issue-body.md
```

**OpenSprinkler-Weather tag taxonomy** (auto-propose, user confirms):

_(none configured)_
- `bug` (bug-mode default)
- `needs-decision` (filed but blocked on a human call)
- `blocked` (waiting on dependency)

**Cost guards:** default to Claude-only investigation. Octo escalation rules below.

---

## STEP 0: Parse Arguments

Two sub-modes:

```
/intake bug "<short title>"     # guided bug filing with hard repro guards
/intake idea "<short title>"    # research-first conversational ideation
```

**Validation:**
- Sub-mode MUST be `bug` or `idea`. Reject anything else with usage message.
- Title MUST be non-empty. If missing, ask the user inline before proceeding.
- Title is a *short* working label (≤ 80 chars), not the full issue title — that gets refined in the conversation.

Extract: `MODE` (bug|idea), `TITLE` (string).

---

## STEP 1: Open Empirica Session

Always open a measurement window — even if the user abandons mid-conversation, the persisted findings survive.

```bash
EMP_SESSION=$(empirica session-create --ai-id claude-code --project-id OpenSprinkler-Weather --output json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);if(!j.ok)process.exit(1);process.stdout.write(j.session_id);})")
echo "$EMP_SESSION" > /tmp/intake-emp-session-$$  # $$ = process id, isolates per-invocation
```

Submit preflight via the helper, with vectors derived from `self-report`:

```bash
SELF_REPORT=$($EMPIRICA_HELPER self-report)
$EMPIRICA_HELPER preflight "$EMP_SESSION" <<EOF
{
  "task_context": "/intake $MODE: $TITLE",
  "vectors": $(echo "$SELF_REPORT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write(JSON.stringify(JSON.parse(d).vectors));})"),
  "reasoning": "Opening intake session for $MODE: $TITLE"
}
EOF
```

If empirica is unavailable, log a WARN and continue — the conversation and issue filing still work, just without persistent findings. Do NOT block intake on Empirica infra failure.

---

## STEP 2: Duplicate / Conflict Scan

Before any discussion or research, check for existing issues that may already cover this:

```bash
# Extract 2-4 high-signal keywords from TITLE (drop articles, common words)
KEYWORDS="<derived from TITLE>"
gh issue list --state all --limit 30 --search "$KEYWORDS" --json number,title,state,labels
```

**If matches found:**
- Show top 3 matches with state (open/closed) and a one-line summary
- Ask the user: *(a) comment on existing #N*, *(b) file new (mine is different because...)*, or *(c) abandon*
- If `(a)`: prepare a comment for `gh issue comment` and skip to Step 4 cleanup. If `(c)`: skip to Step 4 cleanup.
- If `(b)`: capture the differentiator inline in the issue body's "Why this isn't a duplicate of #N" section (Step 4a will surface it via the filing decision-log). No separate Empirica call here — the filing decision in Step 4a is the durable record.

If no matches found, query Empirica directly for semantically-related prior artifacts that the keyword scan missed (this replaces the prior pattern of writing a `finding-log` just to harvest its `suggested_links`):

```bash
RELATED_PRIOR=$($EMPIRICA_HELPER search "$TITLE" --type intelligence --limit 3 2>/dev/null \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const links=(j.results||[]).map(l=>'- ('+l.kind+') '+l.title.slice(0,100)).join('\\n');process.stdout.write(links);}catch(e){}})")
if [ -n "$RELATED_PRIOR" ]; then
  echo "Empirica found related prior research that did NOT match by keyword:"
  echo "$RELATED_PRIOR"
  echo "(Pause to review, or continue with intake.)"
fi
```

Then proceed.

---

## STEP 3: Dispatch to Sub-Mode

- `MODE=bug` → read and follow `.claude/templates/intake-bug.md`
- `MODE=idea` → read and follow `.claude/templates/intake-idea.md`

Each template returns ONE of:
- `READY_TO_FILE` with a populated `intake-issue-body.md` draft and proposed labels → continue to Step 4
- `ABANDONED` with a one-line rationale → continue to Step 4 (file nothing, log decision)
- `MERGED_INTO #N` with the comment posted to existing issue → continue to Step 4

---

## STEP 4: File or Close Out

> **Empirica feature surfaces used below (tested through 1.9.9):**
> - `suggested_links` response field (1.9.2+) — capture from every `*-log` response and surface up to 3 entries so the user can review related prior research before /abc picks the issue up.
> - `--description "<markdown>"` (1.9.5+) — rich markdown body for each `*-log` call; use it to capture issue scope, rationale, repro steps, or abandonment context that doesn't fit in the title field.
> - `--visibility {public,shared,local}` (1.9.3+, MCP parity 1.9.4) — default `local`. Promote to `shared` when the decision/finding is ecosystem-wide (Empirica defects, cross-project patterns, infrastructure gotchas) so other Claude instances can find it via `project-search --global`.
> - `goals-create --description` (1.9.3+) — accepts up to 2000 chars; use it to encode acceptance criteria alongside the title objective.
> - Daemon description round-trip (1.9.9+) — `GET /api/v1/{goals,decisions,assumptions}` now actually return `description` (prior versions had the column from migrations 043+045 but the daemon SELECT was never updated, so reads returned `None`). Rich markdown bodies written here are now visible to downstream readers.
> - `deferred_proposals_note` on POSTFLIGHT (1.9.9+) — Step 5 captures the postflight response and surfaces this field if present so deferred cortex-mailbox proposals do not get forgotten across intake sessions.
> - CHECK gate framing (1.9.9+) — the discriminator is **grounded predictive ability vs priors**, not vectors or ceremony. /intake itself does not call CHECK (no praxic gate between open and close), but the framing applies to any downstream agent or /abc cycle that does.

### 4a. READY_TO_FILE

Show the draft body and proposed labels for final approval:

```
=== Draft for review ===
Title: <refined title from discussion>
Labels: <comma-separated>
Body:
<rendered intake-issue-body.md>
========================
File this? (y/n/edit)
```

If the user types `y`:

```bash
gh issue create \
  --title "<refined title>" \
  --label "<labels comma-separated>" \
  --body "$(cat <rendered body>)"
```

Capture the new issue number `ISSUE_NUM`. Then:

```bash
FILE_DESC=$(cat <<DESC_EOF
## Issue #$ISSUE_NUM filed via /intake $MODE

**Title:** $TITLE
**Labels:** <labels comma-separated>
**Outcome:** filed for /abc pickup

<one-paragraph scope summary: what the issue covers, what prior research informed it, and what's intentionally out of scope>
DESC_EOF
)
FILE_RESPONSE=$(empirica decision-log --choice "Filed issue #$ISSUE_NUM via /intake $MODE: $TITLE" \
  --rationale "<one-line summary of why this is being pursued>" \
  --description "$FILE_DESC" \
  --source "https://github.com/kars85/OpenSprinkler-Weather/issues/$ISSUE_NUM" \
  --epistemic-source mixed \
  --project-id OpenSprinkler-Weather \
  --output json 2>/dev/null || echo '{}')
SUGGESTED_NEXT=$(echo "$FILE_RESPONSE" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const links=(j.suggested_links||[]).slice(0,3).map(l=>'- '+(l.kind||'artifact')+': '+(l.title||'(untitled)')).join('\\n');process.stdout.write(links);}catch(e){}})")

GOAL_DESC=$(cat <<DESC_EOF
## Acceptance criteria

<bulleted list of the concrete checks /abc must satisfy to mark this goal complete: file paths to touch, tests to add or update, contract or schema invariants to preserve, observable behavior change to demonstrate>

## Out of scope

<bulleted list of intentionally-excluded items so /abc doesn't scope-creep>

**Tracks:** https://github.com/kars85/OpenSprinkler-Weather/issues/$ISSUE_NUM
DESC_EOF
)
empirica goals-create --objective "Implement: $TITLE (issue #$ISSUE_NUM)" \
  --description "$GOAL_DESC" \
  --project-id OpenSprinkler-Weather
```

Print: `--- /intake $MODE — FILED #$ISSUE_NUM ---` and the issue URL.
If `$SUGGESTED_NEXT` is non-empty, also print:

```
Related artifacts you may want to skim before /abc:
$SUGGESTED_NEXT
```

Suggest `/abc $ISSUE_NUM` as the next step if appropriate.

If the user types `edit`, accept revisions and re-show. If `n`, treat as ABANDONED.

### 4b. ABANDONED

The user decided not to file. **Findings already persist** from Step 3 (research phase logged each discovery as it was discovered, so the durable record is already in place). No `decision-log` write here — without an anchoring GitHub URL the record had no automated consumer (validated downstream: /abc Phase A's read-back searches for issue-anchored intelligence, not orphan abandonment notes). The Step 3 findings + Step 5 postflight summary together carry the audit trail.

Print: `--- /intake $MODE — ABANDONED ---` and a one-line summary of the rationale. Surface the rationale to the user in the print line so future `project-search` queries against the postflight summary will find context.

### 4c. MERGED_INTO

The user opted to comment on an existing issue. The comment was already posted in Step 2's branch — that is the durable record (GitHub is the system of truth here). No separate `decision-log` write: the existing issue's comment thread carries the rationale, and a /abc cycle picking up issue #N will discover this discussion when it reads the issue body and comments.

Print: `--- /intake $MODE — MERGED INTO #N ---`.

---

## STEP 5: Close Empirica Transaction

Always close the transaction so the next /abc or /intake doesn't trip the Sentinel "Epistemic loop closed" gate:

```bash
EMP_SESSION=$(cat /tmp/intake-emp-session-$$ 2>/dev/null || echo "")
if [ -n "$EMP_SESSION" ]; then
  COMPLETION="1.0"  # filed
  [ "$OUTCOME" = "ABANDONED" ] && COMPLETION="0.5"  # decided not to pursue — still meaningful work
  [ "$OUTCOME" = "MERGED_INTO" ] && COMPLETION="0.7"  # commented on existing
  POSTFLIGHT_RESPONSE=$($EMPIRICA_HELPER postflight "$EMP_SESSION" <<EOF
{
  "summary": "/intake $MODE $OUTCOME for: $TITLE",
  "vectors": { "completion": $COMPLETION, "impact": 0.4, "change": 0.3 },
  "reasoning": "Intake conversation closed. Outcome: $OUTCOME. For READY_TO_FILE see the filing decision-log (anchored to issue URL); for ABANDONED/MERGED_INTO the audit trail is in Step 3 findings + the GitHub artifacts themselves."
}
EOF
)
  # Surface deferred-proposals nudge (1.9.9+) if the postflight response carries one.
  # Field may be a string or {items:[{objective,...}]}. Non-blocking: malformed/missing → silent no-op.
  DEFERRED_NOTE=$(echo "$POSTFLIGHT_RESPONSE" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const n=j.deferred_proposals_note;if(!n)return;if(typeof n==='string'){process.stdout.write(n);return;}if(n.items&&n.items.length){process.stdout.write('Deferred proposals ('+Math.min(10,n.items.length)+'):\\n'+n.items.slice(0,10).map(i=>'  - '+(i.objective||i.title||'(unnamed)')).join('\\n'));}}catch(e){}})" 2>/dev/null)
  if [ -n "$DEFERRED_NOTE" ]; then
    echo ""
    echo "Open deferred mailbox proposals (don't forget):"
    echo "$DEFERRED_NOTE"
  fi
fi
rm -f /tmp/intake-emp-session-$$
```

Postflight failure is non-blocking. Log a WARN and exit normally.

---

## Summary table — what each outcome produces

| Outcome | GitHub state | Empirica state |
|---|---|---|
| `READY_TO_FILE` | new issue #N with abc-compatible checklist | Step 3 findings + filing decision-log (anchored to issue URL) + goals-create (read back by /abc Phase A) + postflight |
| `ABANDONED` | nothing | Step 3 findings (preserved) + postflight only |
| `MERGED_INTO #N` | comment on #N | Step 3 findings (preserved) + postflight only |

In all three outcomes the research is preserved (Step 3 logs findings as they're discovered), the decision is durable where there's an artifact to anchor it (filing → issue URL; merging → existing issue comment thread; abandoning → no anchor, no orphan write), and the Sentinel chain stays intact via session-create + preflight + postflight.
