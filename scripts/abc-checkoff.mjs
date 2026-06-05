#!/usr/bin/env node
// Generic /abc checklist checkoff helper (project-agnostic, gh-based).
// Toggles a single unchecked checklist line to checked on a GitHub issue.
//
// Usage: node scripts/abc-checkoff.mjs --issue <n> --exact "- [ ] <item text>"
//
// Contract (per _config canonical abc skill, Step 5.8):
//  - Operates on the issue in the current repo (gh resolves the repo from cwd).
//  - Idempotent: if the line is already [x], exits 0 (already done).
//  - Prints a small JSON result; the orchestrator independently re-verifies via gh,
//    so this helper only needs to perform the edit and report honestly.

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const issue = arg("--issue");
const exact = arg("--exact");
if (!issue || !exact) {
  console.error(JSON.stringify({ ok: false, error: 'usage: --issue <n> --exact "- [ ] item"' }));
  process.exit(2);
}

const gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });

let body;
try {
  body = gh(["issue", "view", String(issue), "--json", "body", "--jq", ".body"]).replace(/\r\n/g, "\n");
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: "gh issue view failed: " + (e.message || String(e)) }));
  process.exit(1);
}

// Accept either the full "- [ ] text" line or just the item text.
const uncheckedLine = exact.startsWith("- [") ? exact : `- [ ] ${exact}`;
const checkedLine = uncheckedLine.replace("- [ ]", "- [x]");

if (body.includes(checkedLine)) {
  console.log(JSON.stringify({ ok: true, issue: Number(issue), state: "already-checked" }));
  process.exit(0);
}
if (!body.includes(uncheckedLine)) {
  console.error(JSON.stringify({ ok: false, issue: Number(issue), error: "unchecked line not found", line: uncheckedLine }));
  process.exit(1);
}

const newBody = body.replace(uncheckedLine, checkedLine);
const tmp = join(tmpdir(), `abc-checkoff-${issue}-${process.pid}.md`);
writeFileSync(tmp, newBody, "utf8");
try {
  gh(["issue", "edit", String(issue), "--body-file", tmp]);
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: "gh issue edit failed: " + (e.message || String(e)) }));
  process.exit(1);
} finally {
  try { unlinkSync(tmp); } catch {}
}
console.log(JSON.stringify({ ok: true, issue: Number(issue), state: "checked", line: checkedLine }));
