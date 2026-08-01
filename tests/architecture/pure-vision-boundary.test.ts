import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const productionRoots = [
  "apps/cli/src",
  "apps/electron/src",
  "packages/approvals",
  "packages/advertising-core/src",
  "packages/computer-use",
  "packages/tools",
  "packages/application",
  "packages/agent-orchestrator",
  "packages/specialist-agents",
  "packages/visual-table-reader",
  "packages/runtime",
  "packages/server",
  "packages/skills"
];

const forbiddenDependencies = [
  "playwright", "playwright-core", "puppeteer", "selenium", "webdriver",
  "chrome-remote-interface", "google-ads-api", "facebook-nodejs-business-sdk", "tiktok-business-api"
];

const forbiddenExecutionPatterns: Array<[string, RegExp]> = [
  ["DOM query", /\b(?:document\.)?querySelector(?:All)?\s*\(/],
  ["selector locator", /\.locator\s*\(/],
  ["accessibility snapshot", /accessibility\s*\.\s*snapshot\s*\(/],
  ["Chrome DevTools Protocol", /\b(?:CDP|ChromeDevTools|chrome-remote-interface)\b/],
  ["Chrome remote-debugging", /(?:--remote-debugging-port|\/json\/protocol|\/json\/list)/],
  ["WebDriver execution", /\b(?:WebDriver|webdriver)\b/],
  ["browser credential or storage access", /(?:document\.cookie|localStorage|sessionStorage|\.cookies\s*\()/],
  ["advertising API endpoint", /(?:googleads\.googleapis\.com|graph\.facebook\.com|business-api\.tiktok\.com|api\.searchads\.apple\.com|api\.ads\.microsoft\.com|advertising-api\.amazon\.com|api\.linkedin\.com\/rest\/ad)/]
];

const nonExecutablePublisherSourceProperties = new Map<string, readonly string[]>([
  [
    resolve("packages/application/src/plugins.ts"),
    ['sourceUrl: "https://business-api.tiktok.com/portal"']
  ]
]);

describe("pure-vision production architecture", () => {
  it("contains no browser automation or advertising API SDK imports", async () => {
    const violations: string[] = [];
    for (const path of await productionFiles()) {
      const content = await readFile(path, "utf8");
      for (const dependency of forbiddenDependencies) {
        const importPattern = new RegExp(`(?:from\\s*|import\\s*\\(|require\\s*\\()?["']${escapeRegExp(dependency)}(?:/[^"']*)?["']`);
        if (importPattern.test(content)) violations.push(`${path}: imports ${dependency}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("contains no DOM, selector, accessibility-tree, CDP, or WebDriver execution path", async () => {
    const violations: string[] = [];
    for (const path of await productionFiles()) {
      const content = stripNonExecutablePublisherSourceProperties(path, await readFile(path, "utf8"));
      for (const [label, pattern] of forbiddenExecutionPatterns) {
        if (pattern.test(content)) violations.push(`${path}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps browser automation out of production dependencies", async () => {
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {}).filter((name) => forbiddenDependencies.includes(name))).toEqual([]);
  });
});

async function productionFiles(): Promise<string[]> {
  const output: string[] = [];
  for (const root of productionRoots) await walk(resolve(root), output);
  return output.filter((path) => /\.(?:ts|tsx|js|mjs)$/.test(path) && !path.endsWith(".test.ts"));
}

async function walk(directory: string, output: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path, output);
    else output.push(path);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripNonExecutablePublisherSourceProperties(path: string, content: string): string {
  let scannable = content;
  for (const property of nonExecutablePublisherSourceProperties.get(path) ?? []) {
    scannable = scannable.replace(property, 'sourceUrl: "[publisher-source-link]"');
  }
  return scannable;
}
