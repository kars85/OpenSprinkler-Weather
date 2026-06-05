<!-- managed-by: _config\skills\abc\templates\abc-phase-a-batch.md -->
<!-- canonical-sha: d8f34fd00f1e18666b45f3091bc58083d6e097acfc229ab352c264f25e9c40ea -->
<!-- last-synced: 2026-06-05T00:32:53.935Z -->
You are the OpenSprinkler-Weather PM orchestrator running **Phase A in BATCH mode** for an /abc loop.

## Task
Plan **every** currently-unchecked checklist item on GitHub issue #{{ISSUE_NUM}} in ONE pass, so the loop can execute items without re-running Phase A per cycle. You do NOT post a PM-HANDOFF comment in batch mode — you return a structured plan the orchestrator caches and replays.

## Instructions

0. Run Empirica preflight ONCE to establish the epistemic baseline for the whole issue:
   empirica project-bootstrap --project-id OpenSprinkler-Weather --include-live-state --output json --depth auto

   Then read grounded calibration:
   ```
   node C:\\Dev\\_config\\skills\bin\abc-empirica.mjs --project-id OpenSprinkler-Weather gap
   ```
   If `context.status === "REJECT"` (gap > 0.2), set `"epistemicWarning": true` in the output below and include a one-line reason. Do NOT extract vectors from `project-bootstrap` (it returns `{ok, project_id, project_name, breadcrumbs}` only). If bootstrap fails for `OpenSprinkler-Weather`, return `{"status":"EMPIRICA_PREFLIGHT_FAILED"}` and stop. Never run bare `empirica project-bootstrap` without `--project-id OpenSprinkler-Weather`.

1. Read the issue:
   ```bash
   gh issue view {{ISSUE_NUM}} --json number,title,labels,body
   ```

2. Parse the markdown checklist. Collect ALL unchecked items (`- [ ] ...`), preserving their exact line text. Skip checked items (`- [x] ...`).

3. Order the unchecked items by priority: `[P0]` first, then `[P1]`, `[P2]`, `[P3]`, then untagged — and within a tier, document order.

4. Empirica read-back (once for the issue): query prior work so the plan inherits past lessons:
   ```bash
   node C:\\Dev\\_config\\skills\bin\abc-empirica.mjs --project-id OpenSprinkler-Weather search "issue #{{ISSUE_NUM}} <3-5 keywords from the issue title>" --type intelligence --limit 5 2>/dev/null || echo '{"results":[]}'
   ```
   Use any `deadend`/`mistake`/`decision` hits to shape execution steps (avoid repeating failed approaches). Surface the most relevant hits in `priorArtifacts`.

5. For EACH unchecked item, produce:
   - `text`: the exact checklist line text (without the leading `- [ ] `), so the orchestrator can match it against the live issue body.
   - `priority`: `P0|P1|P2|P3|none`.
   - `executionSteps`: 2-6 concrete steps for Codex (Phase B) to implement the item.
   - `scope`: `{ in: "...", out: "..." }`.
   - `filesExpected`: array of repo-relative paths likely to change (best effort).
   - `verificationOnly`: `true` if the item requires NO code change (keywords: "Verify", "All existing tests pass", "Build time remains", "Never change", "Exception:", confirmation items), else `false`.

6. Do NOT post any comment. Do NOT implement anything. Return ONLY the JSON object below, as the final message, inside a single fenced ```json block:

```json
{
  "status": "OK",
  "issue": {{ISSUE_NUM}},
  "epistemicWarning": false,
  "priorArtifacts": ["(kind) title — id"],
  "items": [
    {
      "text": "[P0] <exact item text>",
      "priority": "P0",
      "executionSteps": ["step 1", "step 2"],
      "scope": { "in": "<what to implement>", "out": "<what not to touch>" },
      "filesExpected": ["web/src/..."],
      "verificationOnly": false
    }
  ]
}
```

Rules for the output:
- `items` MUST be in execution (priority) order.
- `text` MUST reproduce the live checklist line exactly (the orchestrator matches on it; a mismatch silently falls back to a per-cycle Phase A agent for that item).
- If there are no unchecked items, return `{"status":"NO_UNCHECKED_ITEMS","issue":{{ISSUE_NUM}},"items":[]}`.
- Emit valid JSON only inside the fence — no prose before or after the fenced block.
