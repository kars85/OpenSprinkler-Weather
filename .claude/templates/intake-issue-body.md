<!-- managed-by: _config\skills\intake\templates\intake-issue-body.md -->
<!-- canonical-sha: 217f6f9aaab895d0e72055f165d7ccda485e209be87fd3f60b38c8d600f13f46 -->
<!-- last-synced: 2026-06-05T00:32:53.935Z -->
<!--
GitHub issue body template for /intake.

Interpolate the placeholders below before passing to `gh issue create --body`.
The output MUST satisfy abc-phase-a.md's regex `- [ ] [P*] ...` so /abc can parse it.

Placeholders (all required):
  {{MODE}}              — bug | idea
  {{SUMMARY}}           — one-paragraph synthesis from the conversation
  {{BACKGROUND}}        — bullet-summarized rationale (mandatory for idea, recommended for bug)
  {{ACCEPTANCE_CRITERIA}} — bullet list of testable outcomes
  {{IN_SCOPE}}          — bullet list of what is covered
  {{OUT_OF_SCOPE}}      — bullet list of what is deferred / not touching
  {{AFFECTED_AREAS}}    — bullet list of paths the work likely touches
  {{CONSTRAINTS}}       — bullet list of tech/policy/style constraints
  {{CHECKLIST}}         — bullet list of `- [ ] [P0|P1|P2] ...` items, ≤ 20

Optional (idea only):
  {{ALTERNATIVES_CONSIDERED}} — bullet list of approaches weighed and not chosen, with brief why-not

Optional (bug only):
  {{FIRST_NOTICED}}     — when the bug was first observed
  {{ENVIRONMENT}}       — browser + route + dev|prod + account/data state

Schema marker `<!-- intake-schema: v1 -->` MUST appear at the top of the rendered body
so future /abc parser updates can detect mismatches.
-->

<!-- intake-schema: v1 -->
<!-- intake-mode: {{MODE}} -->

## Summary

{{SUMMARY}}

## Background / Discussion

{{BACKGROUND}}

<!-- For mode=idea, include alternatives. Delete this section for mode=bug. -->

### Alternatives considered

{{ALTERNATIVES_CONSIDERED}}

<!-- For mode=bug, include first-noticed and environment. Delete for mode=idea. -->

### First noticed

{{FIRST_NOTICED}}

### Environment

{{ENVIRONMENT}}

## Acceptance Criteria

{{ACCEPTANCE_CRITERIA}}

## Scope

**In scope:**
{{IN_SCOPE}}

**Out of scope:**
{{OUT_OF_SCOPE}}

## Affected Areas / Files Expected to Change

{{AFFECTED_AREAS}}

## Constraints

{{CONSTRAINTS}}

## Checklist

{{CHECKLIST}}

---

*Filed via `/intake {{MODE}}`. The discussion that produced this issue (rationale, alternatives considered, related findings) is logged in the Empirica project history for OpenSprinkler-Weather.*
