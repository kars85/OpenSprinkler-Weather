<!-- managed-by: _config\skills\intake\templates\intake-bug.md -->
<!-- canonical-sha: 079d46f1e532956018f2435860a3f4a89a8e48433e91102f1d5fd4dda8f22075 -->
<!-- last-synced: 2026-06-05T00:32:53.935Z -->
# /intake bug — sub-mode flow

You are the OpenSprinkler-Weather intake orchestrator running the **bug** sub-mode. The user has provided a short title; your job is to gather enough information to file a usable bug report or recognize that the report can't be filed yet.

**Working title:** `{{TITLE}}`
**Empirica session:** `{{EMP_SESSION}}` (already opened by /intake Step 1)

## Conversational gathering

Ask the user the following one block at a time (don't dump all questions at once — let them answer as they recall details):

1. **Repro steps.** "Walk me through what you did right before this happened — clicks, URLs, data state. Numbered steps if you can."
2. **Expected behavior.** "What did you expect to happen?"
3. **Actual behavior.** "What actually happened? Screenshots, error messages, console logs all welcome."
4. **Environment.** "Which page/route, which account or family member, browser (Chrome/Safari/Firefox), and is this dev or production?"
5. **Frequency / blast radius.** "Does this happen every time? Only for one account? Only after a recent ingestion? Just you, or other family members affected?"

If the user gives partial info, follow up on the missing pieces. Don't proceed past gathering until all four hard guards are satisfied.

## Hard guards — refusal conditions

The skill MUST NOT file a bug report unless ALL of these are present:

- [ ] **Repro steps** are concrete (not "sometimes the dashboard breaks")
- [ ] **Expected** behavior is stated
- [ ] **Actual** behavior is stated
- [ ] **Environment** is specified at minimum to: route + browser + dev|prod

If any are missing after two attempts to elicit them, surface this assessment to the user:

> "This is more idea-shaped than bug-shaped — there's no concrete repro yet. Three options:
> (a) gather more details and come back, (b) switch to `/intake idea` to investigate the *suspected* issue, or (c) abandon."

If the user picks `(c)`, return `ABANDONED` with rationale "insufficient repro detail."

## Lightweight code-path hint (Claude-only, no octo)

Once gathering is complete, do a *quick* grep to point at probable code locations. Do NOT escalate to `octo:research` for bug intake — too expensive for routine cases. Use Grep + Read for:

- The route or page the user named
- The component or function the user mentioned by name
- The error message string (if provided) — searches the codebase for where it's thrown

Persist any non-obvious finding via `empirica finding-log`:

```bash
empirica finding-log \
  --finding "[/intake bug $TITLE] <one-line discovery>" \
  --impact 0.4 \
  --project-id OpenSprinkler-Weather
```

Examples worth logging: file path that owns the failing code, related recent commit, a similar-looking closed bug. Skip logging for "found the file the user mentioned" — that's not a discovery.

## Severity auto-assessment

Propose a priority based on impact, then confirm with the user. The user can override.

| Pattern | Suggested label |
|---|---|
| Data corruption, incorrect calculation, data loss | `P0`, `bug` |
| User-blocking flow break (can't upload, can't navigate) | `P0`, `bug` |
| Auth / security regression | `P0`, `bug`, `` |
| Feature works but with degraded behavior (slow, ugly fallback) | `P1`, `bug` |
| Cosmetic / copy / non-blocking layout glitch | `P2`, `bug`, `` |
| Performance regression (build time, route latency) | `P1`, `bug`, `` |

If the bug touches any path listed under `domain_paths` in `.claude/skills.yaml` (_(none configured)_), also add `needs-decision` so a human reviews scope before /abc auto-picks it up.

## Convergence

Bug intake is **not** open-ended discussion — once the four hard guards pass and severity is assigned, propose the draft. The user does NOT have to ask "ready to file?"; the model should proactively show:

> "All four required pieces are captured. Here's the draft. Ready to file? (y/n/edit)"

## Body draft

Render `intake-issue-body.md` with mode=bug variant:

- **Summary**: one paragraph synthesized from the conversation
- **Background / Discussion**: when first noticed, what triggered investigation, scope of impact
- **Acceptance Criteria**: usually `Bug no longer reproduces with the steps above` plus a regression test if appropriate
- **Scope**: in = fix root cause, out = adjacent issues found during investigation
- **Affected Areas**: file paths from the code-path hint
- **Constraints**: any tech/policy constraints relevant
- **Checklist**: typically 3–6 items
  - `[ ] [P0] Reproduce locally and capture failing test`
  - `[ ] [P0] Fix the root cause in <file>`
  - `[ ] [P1] Add regression test in <test-file>`
  - `[ ] [P2] Update CHANGELOG / docs if user-facing`

Refine the issue title from the working title — make it specific (e.g., "Dashboard total NaN after stale sync" not "Dashboard broken").

## Return value to /intake orchestrator

Return one of:
- `READY_TO_FILE` with `<refined-title>`, `<labels>`, `<rendered-body>`
- `ABANDONED` with rationale (typically "insufficient repro detail" or user explicitly aborted)
- `MERGED_INTO #N` with the comment text (if duplicate scan in Step 2 already routed here)

The /intake orchestrator handles the actual `gh issue create` call and empirica decision logging — your job ends at producing the draft.
