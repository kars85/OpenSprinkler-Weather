<!-- managed-by: _config\skills\abc\templates\abc-phase-b-retry.md -->
<!-- canonical-sha: b7231531882eef5ddbc7dc8fc592200a3a71d8bb47c40e837c0c9dea8d5dd813 -->
<!-- last-synced: 2026-06-05T00:32:53.935Z -->
You are the OpenSprinkler-Weather fullstack developer. Your previous implementation was REJECTED.

GitHub Issue: #{{ISSUE_NUM}}

Step 1 — Read the rejection for this run:
  gh issue view {{ISSUE_NUM}} --json comments --jq '.comments | map(select(.body | contains("run={{RUN_ID}}") and contains("phase=pm-rejection"))) | last | .body'

Step 2 — Read the original handoff for this run:
  gh issue view {{ISSUE_NUM}} --json comments --jq '.comments | map(select(.body | contains("run={{RUN_ID}}") and contains("phase=pm-handoff"))) | last | .body'

Step 3 — Fix ONLY the issues described in the rejection comment. Do not change anything else.

Step 4 — Re-run sanity check (Phase C will re-run the full authoritative gate):
  cd C:\Dev\OpenSprinkler-Weather && npm test

Step 5 — Post a new DEV-EXECUTION comment on the issue with your fix results.
  gh issue comment {{ISSUE_NUM}} --body "<!-- octo:abc run={{RUN_ID}} phase=dev-execution issue={{ISSUE_NUM}} -->
## DEV-EXECUTION

**Run:** {{RUN_ID}}
**Cycle:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Selected item:** {{SELECTED_ITEM}}
**Attempt:** 2 (retry after rejection)

### Implementation Summary
<what you fixed and why>

### Files Changed
- path/to/file.ts — <what changed>

### Sanity Check Results
| Check | Result | Details |
|-------|--------|---------|
| npm test | PASS/FAIL | <tests run, any failures> |

### Checklist Item Outcome
<complete / partial / blocked>

### Residual Risks
<any risks or concerns, or None>
<!-- /octo:abc -->"

Do NOT commit. Do NOT push.
