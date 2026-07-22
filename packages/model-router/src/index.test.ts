import { describe, expect, it } from "vitest";
import { ModelRouter } from "./index.js";

const router = new ModelRouter({
  fast: { provider: "p", model: "fast" },
  strong: { provider: "p", model: "strong" },
  gui: { provider: "p", model: "vision" },
  guiStrong: { provider: "p", model: "vision-strong" },
  guiDedicated: { provider: "ui-tars", model: "ground" },
  guiDedicatedStrong: { provider: "ui-tars", model: "ground-strong" }
});

describe("ModelRouter", () => {
  it("routes grounding exclusively to the GUI tier", () => {
    expect(router.route({ task: "grounding" })).toMatchObject({
      tier: "gui",
      ref: { provider: "p", model: "vision" },
      guiCandidates: [
        { kind: "dedicated", ref: { provider: "ui-tars", model: "ground" } },
        { kind: "pi-vision", ref: { provider: "p", model: "vision" } }
      ]
    });
  });

  it("uses the strong dedicated GUI model before the strong PiVision fallback", () => {
    expect(router.route({ task: "grounding", computerFailures: 2 })).toMatchObject({
      tier: "strong",
      guiCandidates: [
        { kind: "dedicated", ref: { provider: "ui-tars", model: "ground-strong" } },
        { kind: "pi-vision", ref: { provider: "p", model: "vision-strong" } }
      ]
    });
  });

  it("escalates conflicts, low confidence, failures, and risky reviews", () => {
    expect(router.route({ task: "planning", conflictingSources: true }).tier).toBe("strong");
    expect(router.route({ task: "classification", confidence: 0.3 }).tier).toBe("strong");
    expect(router.route({ task: "screenshot", computerFailures: 2 }).tier).toBe("strong");
    expect(router.route({ task: "risk_review" }).tier).toBe("strong");
  });

  it("keeps ordinary planning on the fast model", () => {
    expect(router.route({ task: "planning", confidence: 0.9 }).tier).toBe("fast");
  });
});
