import { describe, expect, it } from "vitest";
import { composerKeyAction, modelChipLabel, type ComposerKeyEvent } from "./composerKeys.js";

const key = (partial: Partial<ComposerKeyEvent> & { key: string }): ComposerKeyEvent => ({
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  ...partial
});

describe("composerKeyAction without completions", () => {
  it("submits on plain Enter", () => {
    expect(composerKeyAction(key({ key: "Enter" }), 0)).toBe("submit");
  });

  it("lets Shift+Enter fall through to a newline", () => {
    expect(composerKeyAction(key({ key: "Enter", shiftKey: true }), 0)).toBe("ignore");
  });

  it("does not submit on Mod+Enter (desktop convention is plain Enter)", () => {
    expect(composerKeyAction(key({ key: "Enter", metaKey: true }), 0)).toBe("ignore");
    expect(composerKeyAction(key({ key: "Enter", ctrlKey: true }), 0)).toBe("ignore");
  });

  it("ignores ordinary typing", () => {
    expect(composerKeyAction(key({ key: "a" }), 0)).toBe("ignore");
  });
});

describe("composerKeyAction with visible completions", () => {
  it("accepts the highlighted candidate on Tab or Enter", () => {
    expect(composerKeyAction(key({ key: "Tab" }), 3)).toBe("accept-completion");
    expect(composerKeyAction(key({ key: "Enter" }), 3)).toBe("accept-completion");
  });

  it("never submits while completions are visible", () => {
    expect(composerKeyAction(key({ key: "Enter", metaKey: true }), 3)).toBe("accept-completion");
  });

  it("lets Shift+Enter fall through to a newline instead of accepting", () => {
    expect(composerKeyAction(key({ key: "Enter", shiftKey: true }), 3)).toBe("ignore");
  });

  it("moves the highlight with arrows and dismisses on Escape", () => {
    expect(composerKeyAction(key({ key: "ArrowDown" }), 3)).toBe("next-completion");
    expect(composerKeyAction(key({ key: "ArrowUp" }), 3)).toBe("previous-completion");
    expect(composerKeyAction(key({ key: "Escape" }), 3)).toBe("dismiss-completions");
  });
});

describe("modelChipLabel", () => {
  it("strips the provider prefix", () => {
    expect(modelChipLabel("openai/gpt-5-mini", "未配置")).toBe("gpt-5-mini");
    expect(modelChipLabel("gpt-5.2", "未配置")).toBe("gpt-5.2");
  });

  it("falls back to the unassigned copy for empty or malformed values", () => {
    expect(modelChipLabel("", "未配置")).toBe("未配置");
    expect(modelChipLabel("   ", "未配置")).toBe("未配置");
    expect(modelChipLabel("openai/", "未配置")).toBe("未配置");
  });
});
