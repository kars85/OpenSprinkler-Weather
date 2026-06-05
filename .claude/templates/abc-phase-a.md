<!-- managed-by: _config\skills\abc\templates\abc-phase-a.md -->
<!-- canonical-sha: 1143c58416a412f7c58b42710e7518d0b687f313cd53d96e37bd5aa928139e10 -->
<!-- last-synced: 2026-06-05T00:32:53.935Z -->
You are the OpenSprinkler-Weather PM orchestrator running Phase A of an /abc cycle.

## Task
Select a checklist item from GitHub issue #{{ISSUE_NUM}} and post a PM-HANDOFF comment.

## Item Selection
{{ITEM_SELECTION_INSTRUCTION}}

## Instructions

0. Run Empirica preflight to establish epistemic baseline:
   empirica project-bootstrap --project-id OpenSprinkler-Weather --include-live-state --output json --depth auto

   Then read the current grounded calibration via the cross-platform helper (does NOT depend on bootstrap exposing vectors):
   ```
   node C:\\Dev\\_config\\skills\bin\abc-empirica.mjs --project-id OpenSprinkler-Weather gap
   ```
   This returns JSON like `{"context":{"gap":0.0318,"status":"OK"}, ...}`. If `context.status === "REJECT"` (gap > 0.2), WARN in the handoff comment.

   Important:
   - `project-bootstrap` returns `{ok, project_id, project_name, breadcrumbs}` — vectors are NOT in the bootstrap response. Do NOT attempt to extract them from there with `jq` or otherwise. Use `node C:\\Dev\\_config\\skills\bin\abc-empirica.mjs --project-id OpenSprinkler-Weather gap` instead.
   - Do NOT rely on implicit active-project resolution.
   - This repository is explicitly bound to the `OpenSprinkler-Weather` Empirica project.
   - If bootstrap fails for `OpenSprinkler-Weather`, report `EMPIRICA_PREFLIGHT_FAILED` and stop instead of silently falling back to a different project.
   - Never run bare `empirica project-bootstrap` without `--project-id OpenSprinkler-Weather`.

1. Read the issue:
   gh issue view {{ISSUE_NUM}} --json body,title,labels,comments

   If you need a formatted issue preview, use this exact jq shape. The jq program
   is single-quoted by the shell, so do not backslash-escape the quotes inside
   `join(", ")`:

   ```bash
   gh issue view {{ISSUE_NUM}} --json number,title,labels,body --jq '"#\(.number) \(.title)\nLabels: \(.labels | map(.name) | join(", "))\n\n\(.body)"'
   ```

2. Parse the markdown checklist from the issue body. Identify all lines matching:
   - [ ] [P*]...  (unchecked items)
   - [x] [P*]...  (checked items, skip these)

3. Select the next unchecked item by priority order:
   - [P0] items first (in document order)
   - Then [P1], [P2], [P3]
   - Within a tier, first unchecked wins
   {{ITEM_OVERRIDE_INSTRUCTION}}

4. If no unchecked items remain, report: "NO_UNCHECKED_ITEMS" and stop.

5. Read the issue body for acceptance criteria, scope, constraints, and expected files.

5a. **Empirica read-back (closes the write-only-corpus loop).** Before posting the handoff, query Empirica for prior work on this issue and its topic so the handoff inherits the lessons of past /abc and /intake passes:

   ```bash
   SEARCH_QUERY="issue #{{ISSUE_NUM}} <add 3-5 keywords from selected item text>"
   PRIOR_ARTIFACTS=$(node C:\\Dev\\_config\\skills\bin\abc-empirica.mjs --project-id OpenSprinkler-Weather search "$SEARCH_QUERY" --type intelligence --limit 5 2>/dev/null || echo '{"results":[]}')
   ```

   Parse the response. `results` is a normalized list of `{kind, title, id, score}` across goals, decisions, deadends, mistakes, assumptions. Of particular interest:

   - **deadends or mistakes** matching the issue/item → previous attempts that failed; surface their `title` so the Codex prompt can avoid repeating the approach.
   - **decisions** on related issues → records of past scope/architecture calls that should inform this item's bounds.
   - **goals** with status `completed` for the same issue → confirms this item is being re-worked, not first-touched (treat as a regression-risk signal).

   If `results` is non-empty, include a `### Prior Empirica artifacts` section in the PM-HANDOFF comment listing up to 3 hits in the form `- (kind) title — id`. If empty, omit the section.

   This read-back is the principal reason the `*-log` writes from prior cycles and the goals-create from /intake are not write-only — without it the corpus accumulates without ever shaping decisions. Don't skip on empty results; do skip on helper error (continue silently).

   Then derive the CI-observation banner:

   ```bash
   if [ -z "" ]; then
     CI_BANNER="**CI observation:** not configured (\`ci_wait.helper\` is empty). This cycle will ship without remote CI verification — Gate 5 is skipped. Configure \`ci_wait.helper\` in \`.claude/skills.yaml\` to enable."
   else
     CI_BANNER=""
   fi
   ```

6. Post a comment on the issue using gh issue comment:

gh issue comment {{ISSUE_NUM}} --body "$(cat <<'HANDOFF_EOF'
<!-- octo:abc run={{RUN_ID}} phase=pm-handoff issue={{ISSUE_NUM}} -->
## PM-HANDOFF

**Run:** `{{RUN_ID}}`
**Cycle:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Selected item:** `<item text>`

### Acceptance Criteria
<extracted from issue body>

### Execution Steps
1. <step>
2. <step>
3. <step>

### Scope
- **In scope:** <what to implement>
- **Out of scope:** <what not to touch>

### Files Expected to Change
- `<path>`

### Constraints
- <constraints from issue and CLAUDE.md>

### Project Context
- Working directory: C:\Dev\OpenSprinkler-Weather
- Empirica project: OpenSprinkler-Weather
- App directory: C:\Dev\OpenSprinkler-Weather
- Stack: Node.js / TypeScript Express weather service (mocha + ts-node tests, tsc build, Docker-published)
- Required CI checks (Gate 5):  (timeout 1800s; helper: )
$CI_BANNER
- Run tests: cd C:\Dev\OpenSprinkler-Weather && npm test
- Run build: cd C:\Dev\OpenSprinkler-Weather && npm run compile
- Run audit: cd C:\Dev\OpenSprinkler-Weather && npm audit --audit-level=high
- Run lint:  cd C:\Dev\OpenSprinkler-Weather &&   (skip line if LINT_CMD is empty)
<!-- /octo:abc -->
HANDOFF_EOF
)"

7. **Verification-only detection:** After selecting the item, check if ALL remaining unchecked items (including the selected one) are verification/constraint items — i.e., items that require NO code changes. Keywords: "Verify", "All existing tests pass", "Build time remains", "Never change", "Exception:", confirmation items. If ALL remaining items are verification-only, report `VERIFICATION_ONLY` instead of posting a PM-HANDOFF comment, and list all the items to batch-close.

8. **Complexity-aware depth:** If the selected item is a simple attribute/class change (keywords: "aria-", "text-[", "className", "Add `aria-label`", "Replace `text-"), skip deep grep exploration. Post a minimal handoff with just the file path and specific change. Save the deep grep for schema migrations, logic refactors, and multi-file changes.

9. Report back:
   - The EXACT text of the selected item
   - The execution steps (so the orchestrator can inline them into the Codex prompt)
   - Whether `VERIFICATION_ONLY` applies
   - Whether `EMPIRICA_PREFLIGHT_FAILED` applies
