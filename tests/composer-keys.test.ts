import { describe, expect, it } from "vitest";
import { composerKeyAction, type ComposerKeyEvent } from "../apps/desktop/src/composerKeys.js";

function key(overrides: Partial<ComposerKeyEvent>): ComposerKeyEvent {
  return { key: "", shiftKey: false, metaKey: false, ctrlKey: false, ...overrides };
}

describe("desktop composer IME keyboard contract", () => {
  it("does not submit Enter while an IME composition is active", () => {
    expect(composerKeyAction(key({ key: "Enter", isComposing: true }), 0)).toBe("ignore");
  });

  it("does not accept a slash completion while an IME composition is active", () => {
    expect(composerKeyAction(key({ key: "Enter", isComposing: true }), 2)).toBe("ignore");
  });

  it("does not submit Chromium's keyCode 229 composition-ending Enter", () => {
    expect(composerKeyAction(key({ key: "Enter", isComposing: false, keyCode: 229 }), 0)).toBe("ignore");
    expect(composerKeyAction(key({ key: "Enter", isComposing: false, keyCode: 229 }), 2)).toBe("ignore");
  });

  it("keeps ordinary Enter submission unchanged", () => {
    expect(composerKeyAction(key({ key: "Enter" }), 0)).toBe("submit");
  });
});
