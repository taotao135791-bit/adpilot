import { describe, expect, it } from "vitest";
import { chatGoalAdmission } from "./chatAdmission.js";

describe("Home chat goal admission", () => {
  it("preserves a normal first-run draft until a model is configured", () => {
    expect(chatGoalAdmission("audit this account", { busy: false, chatConfigured: false })).toBe("model_required");
  });

  it("admits configured, slash-command and local-insight goals", () => {
    expect(chatGoalAdmission("audit this account", { busy: false, chatConfigured: true })).toBe("accepted");
    expect(chatGoalAdmission("/help", { busy: false, chatConfigured: false })).toBe("accepted");
    expect(chatGoalAdmission("/experiments", { busy: false, chatConfigured: false })).toBe("accepted");
  });

  it("does not accept blank or concurrent submissions", () => {
    expect(chatGoalAdmission("  ", { busy: false, chatConfigured: true })).toBe("empty");
    expect(chatGoalAdmission("next task", { busy: true, chatConfigured: true })).toBe("busy");
  });
});
