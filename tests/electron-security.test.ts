import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isExternalWebUrl, isTrustedDesktopUrl } from "../apps/electron/src/security.js";

describe("Electron navigation security", () => {
  const localOrigin = "http://127.0.0.1:4317";

  it("allows only the exact local server origin", () => {
    expect(isTrustedDesktopUrl("http://127.0.0.1:4317/settings?desktop=1", localOrigin)).toBe(true);
    expect(isTrustedDesktopUrl("http://127.0.0.1:4317.evil.example", localOrigin)).toBe(false);
    expect(isTrustedDesktopUrl("http://localhost:4317", localOrigin)).toBe(false);
    expect(isTrustedDesktopUrl("not a url", localOrigin)).toBe(false);
  });

  it("permits only HTTP(S) URLs to open externally", () => {
    expect(isExternalWebUrl("https://example.com/path")).toBe(true);
    expect(isExternalWebUrl("http://example.com/path")).toBe(true);
    expect(isExternalWebUrl("javascript:alert(1)")).toBe(false);
    expect(isExternalWebUrl("file:///etc/passwd")).toBe(false);
    expect(isExternalWebUrl("mailto:hello@example.com")).toBe(false);
    expect(isExternalWebUrl("not a url")).toBe(false);
  });

  it("uses certificate-free ad-hoc app integrity signing", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      build: { forceCodeSigning: boolean; mac: { identity: string; hardenedRuntime: boolean } };
    };
    expect(packageJson.build.forceCodeSigning).toBe(false);
    expect(packageJson.build.mac).toMatchObject({ identity: "-", hardenedRuntime: false });
  });
});
