import { describe, expect, it } from "vitest";
import {
  offersNativeProjectRootPicker,
  projectRootsAfterSelection
} from "./projectRootSelection.js";

describe("native project-root selection", () => {
  it("leaves the manual draft untouched when the OS chooser is cancelled", () => {
    const draft = "  /workspace/one  \n\n/workspace/two";
    expect(projectRootsAfterSelection(draft, { cancelled: true })).toBe(draft);
  });

  it("fills rootPaths with a selected directory without duplicating an existing root", () => {
    expect(projectRootsAfterSelection("/workspace/one", {
      cancelled: false,
      path: "/workspace/two"
    })).toBe("/workspace/one\n/workspace/two");
    expect(projectRootsAfterSelection(" /workspace/one ", {
      cancelled: false,
      path: "/workspace/one"
    })).toBe(" /workspace/one ");
  });

  it("offers the native control only for development projects in the desktop shell", () => {
    expect(offersNativeProjectRootPicker(true, "development")).toBe(true);
    expect(offersNativeProjectRootPicker(false, "development")).toBe(false);
    expect(offersNativeProjectRootPicker(true, "advertising")).toBe(false);
  });
});
