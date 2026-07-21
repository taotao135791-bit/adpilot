import { describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { PiVisionModel, VisualAction, VisualComputerRuntime, VisualPolicy, type NativeOperator, type Screenshot } from "./index.js";

const before: Screenshot = { base64: "before", width: 1000, height: 800, scaleFactor: 2, capturedAt: "2026-01-01T00:00:00.000Z", sha256: "a".repeat(64) };
const after: Screenshot = { ...before, base64: "after", capturedAt: "2026-01-01T00:00:01.000Z", sha256: "b".repeat(64) };
const task = {
  instruction: "Open date selector", target: "date selector", expectedResult: "date menu is open",
  riskLevel: "interact" as const, permission: "INTERACT" as const,
  surface: { app: "Browser", domain: "ads.google.com", allowedApps: ["Browser"], allowedDomains: ["ads.google.com"] }
};

describe("visual action protocol", () => {
  it("rejects invalid actions and coordinates", () => {
    expect(() => VisualAction.parse({ action: "click", x: -1 })).toThrow();
    const action = VisualAction.parse({ action: "click", x: 1200, y: 20, target: "x", reason: "x", confidence: 1, expected_result: "x", risk_level: "interact" });
    expect(() => new VisualPolicy().check(action, before, task)).toThrow("outside");
  });

  it("executes screenshot-ground-action-screenshot-verify", async () => {
    const executed: string[] = [];
    const operator: NativeOperator = { capture: async () => executed.length ? after : before, execute: async (action) => { executed.push(action.action); } };
    const runtime = new VisualComputerRuntime(operator, {
      ground: async () => ({ action: "click", x: 100, y: 100, target: "date selector", reason: "visible", confidence: 0.9, expected_result: "date menu is open", risk_level: "interact" })
    }, { verify: async () => ({ matched: true, confidence: 0.95, reason: "menu visible" }) });
    const result = await runtime.runMicroTask(task);
    expect(result.status).toBe("done");
    expect(executed).toEqual(["click"]);
  });

  it("re-screenshots, escalates, and stops after the third failure", async () => {
    const tiers: string[] = [];
    let captures = 0;
    const runtime = new VisualComputerRuntime(
      { capture: async () => ({ ...before, capturedAt: new Date(1_700_000_000_000 + captures++).toISOString() }), execute: async () => undefined },
      { ground: async (_task, _shot, tier) => { tiers.push(tier); return { action: "click", x: 10, y: 10, target: "date selector", reason: "try", confidence: 0.5, expected_result: "date menu is open", risk_level: "interact" }; } },
      { verify: async () => ({ matched: false, confidence: 1, reason: "unchanged" }) }
    );
    const result = await runtime.runMicroTask(task);
    expect(result).toMatchObject({ status: "failed", attempts: 3 });
    expect(tiers).toEqual(["gui", "gui", "strong"]);
    expect(captures).toBe(6);
  });

  it("blocks mutation under observe permission and non-allowlisted domains", () => {
    const action = VisualAction.parse({ action: "click", x: 10, y: 10, target: "save", reason: "submit", confidence: 1, expected_result: "saved", risk_level: "mutate" });
    expect(() => new VisualPolicy().check(action, before, { ...task, riskLevel: "mutate", permission: "OBSERVE" })).toThrow("does not allow");
    expect(() => new VisualPolicy().check({ ...action, risk_level: "interact" }, before, { ...task, surface: { ...task.surface, domain: "evil.example" } })).toThrow("not allowlisted");
  });

  it("stops immediately on timeout to avoid duplicate actions", async () => {
    const runtime = new VisualComputerRuntime(
      { capture: async () => new Promise<Screenshot>(() => undefined), execute: async () => undefined },
      { ground: async () => { throw new Error("should not ground"); } },
      { verify: async () => ({ matched: false, confidence: 0, reason: "not reached" }) },
      new VisualPolicy(),
      () => undefined,
      5
    );
    await expect(runtime.runMicroTask(task)).resolves.toMatchObject({ status: "failed", attempts: 1, blocker: expect.stringContaining("timed out") });
  });

  it("honors user cancellation before taking a screenshot", async () => {
    let captures = 0;
    const runtime = new VisualComputerRuntime(
      { capture: async () => { captures += 1; return before; }, execute: async () => undefined },
      { ground: async () => ({ action: "done", target: "task", reason: "done", confidence: 1, expected_result: "done", risk_level: "observe" }) },
      { verify: async () => ({ matched: true, confidence: 1, reason: "done" }) }
    );
    runtime.cancel();
    await expect(runtime.runMicroTask(task)).resolves.toMatchObject({ status: "failed", attempts: 0, blocker: "user cancelled" });
    expect(captures).toBe(0);
  });

  it("uses one Pi vision-capable code model for grounding and verification", async () => {
    const faux = fauxProvider({ provider: "code", models: [{ id: "code-fast", input: ["text", "image"] }, { id: "code-strong", input: ["text", "image"], reasoning: true }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      (context) => {
        const user = context.messages[0];
        expect(user?.role).toBe("user");
        expect(user?.role === "user" && Array.isArray(user.content) && user.content.some((item) => item.type === "image")).toBe(true);
        return fauxAssistantMessage('{"action":"click","x":120,"y":80,"target":"date selector","reason":"visible","confidence":0.94,"expected_result":"date menu is open","risk_level":"interact"}');
      },
      fauxAssistantMessage('{"matched":true,"confidence":0.91,"reason":"menu is visibly open"}')
    ]);
    const vision = new PiVisionModel(models, faux.getModel("code-fast")!, faux.getModel("code-strong")!);
    await expect(vision.ground(task, before, "gui")).resolves.toMatchObject({ action: "click", x: 120, y: 80 });
    await expect(vision.verify(task.expectedResult, before, after)).resolves.toEqual({ matched: true, confidence: 0.91, reason: "menu is visibly open" });
  });
});
