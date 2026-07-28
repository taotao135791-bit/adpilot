import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright-core";

const url = process.env.ADPILOT_CAPTURE_URL ?? "http://localhost:4319/";
const out = (name) => `/tmp/adpilot-state-${name}.png`;
const executablePath = process.env.ADPILOT_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await mkdir("/tmp", { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath, args: ["--no-first-run", "--no-default-browser-check"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: "dark" });
try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".shell");
  await page.waitForTimeout(1200);

  const shots = process.argv[2] ? process.argv[2].split(",") : ["settings", "permissions", "plugins"];
  for (const shot of shots) {
    if (shot === "settings") {
      await page.click('button[aria-label*="设置"], button[aria-label*="Settings"]').catch(() => page.click(".sidebar-foot .icon-button"));
      await page.waitForTimeout(600);
    } else if (shot === "permissions") {
      await page.click('button[aria-label*="设置"], button[aria-label*="Settings"]').catch(() => {});
      await page.waitForTimeout(600);
      await page.click('text=/权限|Permissions/').catch(() => {});
      await page.waitForTimeout(900);
    } else if (shot === "plugins") {
      await page.click('button:has-text("插件"), button:has-text("Plugins")').catch(() => page.click(".sidebar-foot .icon-button").catch(() => {}));
      await page.waitForTimeout(800);
    } else if (shot === "session") {
      await page.click(".session-open").catch(() => {});
      await page.waitForTimeout(900);
    } else if (shot === "composer-focus") {
      await page.click(".composer .textarea").catch(() => {});
      await page.waitForTimeout(400);
    }
    await page.screenshot({ path: out(shot) });
    console.log(out(shot));
    if (shot === "settings" || shot === "permissions") {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
    }
  }
} finally {
  await browser.close();
}
