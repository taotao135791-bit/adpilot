import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

const url = process.env.ADPILOT_CAPTURE_URL ?? "http://127.0.0.1:4317/";
const output = resolve(process.env.ADPILOT_CAPTURE_OUTPUT ?? "docs/screenshots/adpilot-console.png");
const executablePath = process.env.ADPILOT_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await mkdir(dirname(output), { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath, args: ["--no-first-run", "--no-default-browser-check"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: "dark" });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".shell");
  await page.waitForTimeout(900);
  await page.screenshot({ path: output, fullPage: true });
  console.log(output);
} finally {
  await browser.close();
}
