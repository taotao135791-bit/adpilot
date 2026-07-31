#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { readFile } from "node:fs/promises";

/**
 * Repository privacy gate.
 *
 * It scans first-party tracked files, excludes the vendored upstream mirror,
 * and deliberately never prints a matched value. Findings contain only the
 * path, line and rule so CI logs cannot become a second secret leak.
 */

const tracked = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ".", ":(exclude)upstream/**"],
  { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
).split("\0").filter(Boolean);

const genericMacUsernames = new Set([
  "alice",
  "example",
  "john",
  "u",
  "username",
  "x",
  "you"
]);

const allowedLiteralFixtures = new Map([
  [
    "packages/plugin-runtime/src/index.test.ts",
    new Set([["sk", "should", "never", "appear"].join("-")])
  ],
  [
    "packages/tools/src/general/bash.test.ts",
    new Set([["sk", "test", "should", "not", "leak"].join("-")])
  ]
]);

const secretRules = [
  { id: "openai_or_anthropic_token", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { id: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { id: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { id: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { id: "stripe_live_key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g },
  { id: "private_key_block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g }
];

const findings = [];

for (const path of tracked) {
  const fileName = basename(path);
  if (
    (fileName === ".env" || (fileName.startsWith(".env.") && fileName !== ".env.example"))
    || fileName === "pi-auth.json"
    || fileName === "settings.json"
  ) {
    findings.push({ path, line: 1, rule: "sensitive_file_tracked" });
    continue;
  }

  const buffer = await readFile(path);
  if (buffer.includes(0)) continue;
  const content = buffer.toString("utf8");

  for (const rule of secretRules) {
    rule.pattern.lastIndex = 0;
    for (const match of content.matchAll(rule.pattern)) {
      const literal = match[0];
      if (allowedLiteralFixtures.get(path)?.has(literal)) continue;
      findings.push({
        path,
        line: lineAt(content, match.index ?? 0),
        rule: rule.id
      });
    }
  }

  const macPath = /\/Users\/([A-Za-z0-9._-]+)/g;
  for (const match of content.matchAll(macPath)) {
    const username = match[1] ?? "";
    if (genericMacUsernames.has(username)) continue;
    findings.push({
      path,
      line: lineAt(content, match.index ?? 0),
      rule: "personal_home_path"
    });
  }
}

if (findings.length > 0) {
  console.error(JSON.stringify({
    status: "failed",
    check: "privacy",
    filesChecked: tracked.length,
    // Never include the matched text.
    findings
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "passed",
  check: "privacy",
  filesChecked: tracked.length,
  allowlistedFixtures: [...allowedLiteralFixtures.values()]
    .reduce((count, entries) => count + entries.size, 0)
}, null, 2));

function lineAt(content, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}
