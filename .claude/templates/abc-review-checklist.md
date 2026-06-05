# {{PROJECT_ID}} Code Review Checklist (Gate 2)

This file is **project-local** — `/abc` Phase C reads it from `<project>/.claude/templates/abc-review-checklist.md`,
not from the canonical `_config\skills\abc\templates\` source. Each project ships its own calibrated version.

The skeleton below is the generic starter. Replace the placeholder bullets under each section with project-specific
review concerns (e.g., compliance rule constraints, framework conventions, performance budgets).

Modeled after REVIEW.md severity conventions from Claude Code.

## What Important means here (reject if violated)

Reserve Important for findings that would break behavior, leak data, violate domain policy, or produce incorrect
outputs that downstream code depends on:

- _<Project-specific correctness or policy violation>_
- _<Project-specific security or data integrity violation>_
- _<Project-specific schema/migration discipline>_
- PII/secrets in logs, error messages, or client-side bundles
- Authentication/authorization bypass on new routes
- Database queries missing tenant/session scoping (if multi-tenant)

## What Nit means here (warn but don't reject)

- _<Project-specific styling/convention nit>_
- _<Project-specific test coverage gap>_
- File/component naming convention drift
- Test exists but doesn't cover new behavior's happy path

## Do not report

- Anything CI already enforces (linters, type checkers, formatters)
- Generated files (build outputs, lockfiles, vendored dependencies)
- Test-only code that intentionally violates production rules for isolation

## Always check

- New API routes have an auth gate
- _<Project-specific cross-file invariants>_
- Database schema changes are backwards-compatible or have a migration
- _<Project-specific registration/wiring requirements (e.g., new component registered in registry file)>_

## CI workflow changes (only when `.github/workflows/**` is in the diff)

- New step added inside a job with `defaults.run.working-directory:` set — does
  it run **before** `actions/checkout`? If yes, hoist Checkout or override the
  step's `working-directory:` to `${{ github.workspace }}`. Otherwise bash fails
  to start with "No such file or directory" on the missing dir.
- New `actions/upload-artifact@v5` step paths to anything starting with `.`
  (e.g. `.next`, `.cache`, `.coverage`) — does it set `include-hidden-files: true`?
  v5 changed the default from `true` to `false`; dot-prefixed paths upload zero
  files and trip `if-no-files-found: error`.
- _<Project-specific CI/workflow invariants>_
# /abc latency and closeout checks

- [ ] If the simple-item fast path was used, the item met the documented
      low-risk criteria and the final evidence includes structured skip reasons
      for every skipped broad gate.
- [ ] Verification matched the changed-file risk matrix; any missing focused
      test was recorded as a test gap instead of silently ignored.
- [ ] Mechanical closeout used configured helpers where available and did not
      require ad hoc Bash-only mutation logic on Windows.
- [ ] Bash snippets did not use raw Windows backslash paths such as
      `cd C:\Dev\...`; paths were normalized or written with forward slashes.
- [ ] Commit staging used explicit intended file pathspecs and did not use broad
      directory staging such as `git add web/` or `git add -u web/`.
- [ ] Push synchronization used `git fetch` plus ancestry checks; it did not run
      `git pull --rebase` across unrelated dirty working-tree changes.
- [ ] Gate 4 Empirica postflight was terminal: no release bookkeeping, checklist
      mutation, Empirica goal/finding mutation, second preflight, or recovery
      churn occurred after successful postflight.
