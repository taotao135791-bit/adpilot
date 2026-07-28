#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const mode = process.argv[2] ?? "lint";
if (!["format", "lint"].includes(mode)) {
  console.error("usage: node scripts/repository-hygiene.mjs <format|lint>");
  process.exit(64);
}

const firstPartyRoots = [
  "apps/",
  "packages/",
  "scripts/",
  "tests/",
  "evals/",
  "docs/computer-use/"
];
const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".mjs",
  ".js",
  ".json",
  ".md",
  ".swift",
  ".sh",
  ".yml",
  ".yaml",
  ".plist"
]);
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" }
)
  .split("\0")
  .filter(Boolean)
  .filter((path) => firstPartyRoots.some((root) => path.startsWith(root)))
  .filter((path) => textExtensions.has(extname(path)));
const failures = [];

for (const path of files) {
  const content = await readFile(path, "utf8");
  if (mode === "format") {
    if (content.includes("\r")) failures.push(`${path}: contains CRLF or bare CR`);
    if (content.length > 0 && !content.endsWith("\n")) {
      failures.push(`${path}: missing final newline`);
    }
    const trailing = content.split("\n").findIndex((line) => /[ \t]+$/.test(line));
    if (trailing >= 0) failures.push(`${path}:${trailing + 1}: trailing whitespace`);
    continue;
  }
  const conflict = content.split("\n").findIndex((line) =>
    /^(<{7}|={7}|>{7})(?:\s|$)/.test(line)
  );
  if (conflict >= 0) failures.push(`${path}:${conflict + 1}: unresolved merge marker`);
  if (/\.only\s*\(/.test(content) && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) {
    failures.push(`${path}: focused test (.only) is not allowed`);
  }
  if (/child_process\.(?:exec|execSync)\s*\(/.test(content)) {
    failures.push(`${path}: prefer argument-vector process execution over a shell string`);
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({
    status: "failed",
    check: mode,
    filesChecked: files.length,
    failures
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "passed",
  check: mode,
  filesChecked: files.length
}, null, 2));
