import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const url = process.env.ADPILOT_CAPTURE_URL ?? "http://localhost:4319/";
const outputDirectory = resolve(process.env.ADPILOT_CAPTURE_DIR ?? "/tmp");
const out = (name) => resolve(outputDirectory, `adpilot-state-${name}.png`);
const executablePath = process.env.ADPILOT_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath, args: ["--no-first-run", "--no-default-browser-check"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: "dark" });
page.setDefaultTimeout(2500);
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
      await page.click('button[aria-label*="插件"], button[aria-label*="Plugins"]').catch(() => {});
      await page.waitForTimeout(800);
    } else if (shot === "skills") {
      await page.click('button[aria-label="技能"], button[aria-label="Skills"]').catch(() => {});
      await page.waitForTimeout(800);
    } else if (shot === "first-run-draft") {
      const draft = "Synthetic draft must survive model setup";
      await page.click('button[aria-label="首页"], button[aria-label="Home"]').catch(() => {});
      await page.fill(".home-composer textarea", draft);
      await page.click(".home-mode-item:first-child");
      await page.waitForSelector('.settings-panel, [role="dialog"]');
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const preserved = await page.inputValue(".home-composer textarea");
      if (preserved !== draft) throw new Error("Home draft was lost while opening model setup");
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
