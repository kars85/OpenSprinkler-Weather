<!-- managed-by: _config\skills\intake\templates\intake-idea.md -->
<!-- canonical-sha: 47054ad0e8b83d1e993657ece7efb19a86e4c60474139645ff01e1d98b0823a5 -->
<!-- last-synced: 2026-06-05T00:32:53.935Z -->
# /intake idea — sub-mode flow

You are the OpenSprinkler-Weather intake orchestrator running the **idea** sub-mode. The user has provided a short title for an idea they want to investigate or discuss; your job is to research, discuss, and either file a well-formed GitHub issue or capture the decision not to pursue.

**Working title:** `{{TITLE}}`
**Empirica session:** `{{EMP_SESSION}}` (already opened by /intake Step 1)

## Phase 1 — Research first (always)

Before opening discussion, gather context. **Persist every relevant finding immediately** via `empirica finding-log` so the work survives if the user abandons later.

### 1a. Codebase grep (Claude-native, free)

Search for keywords from the title across the repo:

```bash
# Use Grep tool, not Bash grep, for performance + filtering
# Look for: route names, model names, component names, function names matching the idea
```

Identify the 3–5 most relevant file paths. For each non-obvious one:

```bash
empirica finding-log \
  --finding "[/intake idea $TITLE] Related code path: <path> — <one-line of what's there>" \
  --impact 0.4 \
  --project-id OpenSprinkler-Weather
```

### 1b. Related GitHub issues

```bash
KEYWORDS="<2-4 derived keywords>"
gh issue list --state all --limit 30 --search "$KEYWORDS" --json number,title,state
```

For any issue that meaningfully overlaps:

```bash
empirica finding-log \
  --finding "[/intake idea $TITLE] Related issue: #N — <title> (<state>) — <one-line on overlap>" \
  --impact 0.5 \
  --project-id OpenSprinkler-Weather
```

If a high-overlap match is found, surface it before continuing — the user may want to merge into the existing issue rather than file new.

### 1c. Domain policy intersection (compliance check)

If the idea touches any project-defined domain (compliance, security boundaries, or other policy zones declared in `.claude/skills.yaml` under `domain_triggers`): read the relevant code paths and policy docs to identify which domain rules might be affected. Persist findings.

If the idea mentions any of these compliance keywords, this check is mandatory: _(none configured)_.

### 1d. Calibration baseline

```bash
node C:\\Dev\\_config\\skills\bin\abc-empirica.mjs --project-id OpenSprinkler-Weather gap
```

If `context.status === "WARN"` or `"REJECT"`, surface this to the user before discussing:

> "Heads up — current context-gap is X.XX (status: WARN). Calibration says I'm over-confident on context right now. I may push back harder than usual or recommend more research before scoping."

This isn't a stop sign — it's transparency. The user can choose to proceed anyway.

### 1e. Optional escalation: octo:research

Default off. Trigger `octo:research` ONLY if:

- The user says "deep dive," "research thoroughly," "full investigation," or similar; OR
- Phase 1a surfaced more than 5 distinct file paths (idea spans many areas); OR
- Phase 1b found 3+ related issues (likely a recurring theme worth synthesizing)

If triggered, invoke via the Skill tool:

```
Skill: octo:research
args: "<keywords + scope from title and Phase 1 findings>"
```

Persist the research summary as a single high-impact finding:

```bash
empirica finding-log \
  --finding "[/intake idea $TITLE] octo:research summary: <distilled key insights>" \
  --impact 0.7 \
  --project-id OpenSprinkler-Weather
```

## Phase 2 — Conversational discussion

Now open a back-and-forth with the user. Cover (in any order — let the user lead):

- **Problem statement.** What specific gap or unmet need is this addressing?
- **Motivation.** Why now? What changed, or what pain point is this scratching?
- **Alternatives considered.** Have we tried other approaches? Could we accomplish the same outcome with less work?
- **Rough scope.** What's in / what's out? Where does this clearly NOT go?
- **Approximate sizing.** One issue's worth of work (roughly one /abc loop), or bigger?

Use the research findings from Phase 1 to inform the discussion — surface relevant existing code, related issues, calibration concerns. Don't dump them all at once; bring them in when relevant.

### When to invoke `superpowers:brainstorming`

If the discussion shifts from "should we do this?" to concrete design ("how would we structure it?", "what does the API look like?"), invoke the structured brainstorming skill:

```
Skill: superpowers:brainstorming
```

That skill handles the implementation-design phase better than free-form conversation. After brainstorming returns, fold its output into the issue draft.

### Octo:debate — auto-trigger conditions

If the idea touches **any** of the following, automatically invoke `octo:debate` before drafting (no user opt-in needed):

- **Compliance keywords:** _(none configured)_
- **Security keywords:** _(none configured)_
- **Schema paths:** _(none configured)_

Invoke as:

```
Skill: octo:debate
args: "<refined problem statement + proposed approach + the 2-3 main alternatives>"
```

Persist the debate outcome:

```bash
empirica finding-log \
  --finding "[/intake idea $TITLE] octo:debate consensus: <chosen approach> — dissenting views: <summary>" \
  --impact 0.8 \
  --project-id OpenSprinkler-Weather
```

If the debate reveals a fundamental disagreement (e.g., approach is unsafe, would break a compliance rule, regresses security), surface this to the user and offer to abandon or rescope.

## Phase 3 — Convergence (hybrid: model-proposed, user-approved)

The model watches for convergence signals during discussion:

- The user has stopped adding new requirements for 2+ turns
- Scope (in/out) is concrete
- Sizing is agreed
- Open questions list is empty or only has follow-up items

When all four are true, the model proactively asks:

> "I think we have enough to draft. Want me to show the issue body, or keep discussing?"

The user approves (`yes`, `show me`, `draft it`) or asks for more discussion. Convergence is **not** time-boxed; the user steers when it ends.

## Phase 4 — Pre-file checks

Before showing the draft:

### 4a. Sizing guard

If the proposed checklist exceeds **20 items**, propose splitting:

> "This is shaping up to 25+ items. That's bigger than one /abc loop can chew through. Want to: (a) split into an epic with sub-issues, (b) trim scope to a P0 first pass, or (c) file as-is and let /abc work it incrementally?"

If the user picks (a), help them define the epic boundaries and create the parent issue first, then 2–4 sub-issues that link to it.

### 4b. Tag proposal

Auto-derive labels from the discussion content. Project category labels (from `labels.category_scheme` in `.claude/skills.yaml`):

_(none configured)_

Process labels: `needs-decision` (if any unresolved question remains), `blocked` (waiting on dependency), `bug` (when bug-shaped despite being filed via idea).

Domain labels (up to 2 per issue, project-defined): _(none configured)_.

Propose, user confirms. If uncertain about an existing label, check `gh label list`.

### 4c. Unresolved questions / unknowns

For any open question the discussion didn't resolve:

```bash
empirica unknown-log \
  --unknown "[/intake idea $TITLE] Open question: <question>" \
  --project-id OpenSprinkler-Weather
```

Add `needs-decision` label so the issue surfaces these for human review before /abc auto-picks it.

## Phase 5 — Body draft

Render `intake-issue-body.md` with mode=idea variant:

- **Summary**: one paragraph synthesized from the conversation
- **Background / Discussion**: bullet-summarized rationale — *why this, why now, alternatives considered*. This section is critical for an idea: it captures the thinking that future PMs need to understand the issue cold.
- **Acceptance Criteria**: testable outcomes, ordered by importance
- **Scope**: in / out (be explicit on out — that's where regret lives)
- **Files Expected to Change**: from Phase 1 research
- **Constraints**: tech/policy/style constraints from CLAUDE.md and project policy docs
- **Checklist**: P0/P1/P2 items, ≤ 20 (or split into epic)

Refine the issue title from the working title — make it specific and outcome-oriented (e.g., "Add asset-location optimizer for new family members" not "asset location stuff").

## Return value to /intake orchestrator

Return one of:
- `READY_TO_FILE` with `<refined-title>`, `<labels>`, `<rendered-body>`
- `READY_TO_FILE_AS_EPIC` with parent + child drafts (if Phase 4a triggered split)
- `ABANDONED` with rationale (typically "alternative chosen", "out of scope for current quarter", "not worth the cost", etc.)
- `MERGED_INTO #N` with the comment text (if duplicate scan in /intake Step 2 routed here, or a Phase 1b match was confirmed)

The /intake orchestrator handles the actual `gh issue create` call and empirica decision logging — your job ends at producing the draft (or, for `READY_TO_FILE_AS_EPIC`, multiple drafts in dependency order).
