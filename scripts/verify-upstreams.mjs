import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pins = JSON.parse(await readFile(new URL("../UPSTREAM_VERSIONS.json", import.meta.url), "utf8"));

function head(path) {
  return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

const actual = { pi: head("upstream/pi"), uiTars: head("upstream/ui-tars") };
const expected = { pi: pins.pi.commit, uiTars: pins.uiTars.commit };
if (actual.pi !== expected.pi || actual.uiTars !== expected.uiTars) {
  console.error(JSON.stringify({ status: "mismatch", expected, actual }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: "ok", pins: actual }, null, 2));
}
