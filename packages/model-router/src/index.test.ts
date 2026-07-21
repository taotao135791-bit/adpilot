import { describe, expect, it } from "vitest";
import { ModelRouter } from "./index.js";

const router = new ModelRouter({
  fast: { provider: "p", model: "fast" },
  strong: { provider: "p", model: "strong" },
  gui: { provider: "g", model: "ground" }
});

describe("ModelRouter", () => {
  it("routes grounding exclusively to the GUI tier", () => {
    expect(router.route({ task: "grounding" }).tier).toBe("gui");
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

