import { createHash } from "node:crypto";
import { Jimp } from "jimp";
import { describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  GuiGroundingProviderRouter,
  ExecutableVisualAction,
  MacOSNativeSurfaceIdentity,
  NativeSurfaceUnavailableError,
  OpenAICompatibleUiTarsProvider,
  PiVisionModel,
  UiTarsNativeOperator,
  VisualAction,
  VisualComputerRuntime,
  VisualPolicy,
  fingerprintSurface,
  type NativeOperator,
  type NativeSurface,
    type NativeSurfaceIdentity,
    type Screenshot,
    type VisualGroundingProvider,
    type VisualMicroTask
} from "./index.js";

const before: Screenshot = { base64: "before", width: 1000, height: 800, scaleFactor: 2, capturedAt: "2026-01-01T00:00:00.000Z", sha256: "a".repeat(64) };
const after: Screenshot = { ...before, base64: "after", capturedAt: "2026-01-01T00:00:01.000Z", sha256: "b".repeat(64) };
const nativeSurface: NativeSurface = {
  platform: "darwin", app: "Browser", bundleId: "com.example.browser", pid: 42, title: "Ads",
  windowId: "7", bounds: { x: 100, y: 50, width: 500, height: 400 },
  screenId: "1", screenBounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2
};
const task = {
  instruction: "Open date selector", target: "date selector", expectedResult: "date menu is open",
  riskLevel: "interact" as const, permission: "INTERACT" as const,
  surface: { app: "Browser", domain: "ads.google.com", allowedApps: ["Browser"], allowedDomains: ["ads.google.com"] }
};

describe("visual action protocol", () => {
  it("rejects invalid actions and coordinates", () => {
    expect(() => VisualAction.parse({ action: "click", x: -1 })).toThrow();
    expect(() => ExecutableVisualAction.parse({ action: "done", target: "x", reason: "x", confidence: 1, expected_result: "x", risk_level: "observe" })).toThrow();
    const action = VisualAction.parse({ action: "click", x: 1200, y: 20, target: task.target, reason: "x", confidence: 1, expected_result: task.expectedResult, risk_level: "interact" });
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
    expect(result.status === "done" && result.action).toMatchObject({
      task_id: expect.stringMatching(/^task_/),
      step_id: expect.stringMatching(/^step_/),
      taskId: expect.stringMatching(/^task_/),
      stepId: expect.stringMatching(/^step_/),
      planId: expect.stringMatching(/^plan_/),
      surface_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      surfaceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      accountFingerprint: before.sha256,
      allowedRegion: { x: 0, y: 0, width: before.width, height: before.height, coordinateSpace: "screenshot_pixels" }
    });
  });

  it("applies a narrowing action-kind guard before native input", async () => {
    let executions = 0;
    const runtime = new VisualComputerRuntime(
      { capture: async () => before, execute: async () => { executions += 1; } },
      { ground: async () => ({ action: "click", x: 100, y: 100, target: "date selector", reason: "visible", confidence: 1, expected_result: "date menu is open", risk_level: "interact" }) },
      { verify: async () => ({ matched: true, confidence: 1, reason: "open" }) }
    );
    await expect(runtime.runMicroTask(task, undefined, { allowedActions: ["type"] })).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      blockerCode: "POLICY_BLOCKED",
      blocker: "action click is outside this restricted execution step"
    });
    expect(executions).toBe(0);
  });

  it("re-screenshots, escalates, and stops after the third failure", async () => {
    const tiers: string[] = [];
    let captures = 0;
    const runtime = new VisualComputerRuntime(
      { capture: async () => ({ ...before, capturedAt: new Date(1_700_000_000_000 + captures++).toISOString() }), execute: async () => undefined },
      { ground: async (_task, _shot, tier) => { tiers.push(tier); return { action: "click", x: 10 + tiers.length, y: 10, target: "date selector", reason: "try", confidence: 0.5, expected_result: "date menu is open", risk_level: "interact" }; } },
      { verify: async () => ({ matched: false, confidence: 1, reason: "unchanged" }) }
    );
    const result = await runtime.runMicroTask(task);
    expect(result).toMatchObject({ status: "failed", attempts: 3 });
    expect(tiers).toEqual(["gui", "gui", "strong"]);
    expect(captures).toBe(6);
  });

  it("blocks mutation under observe permission and non-allowlisted domains", () => {
    const action = VisualAction.parse({ action: "click", x: 10, y: 10, target: task.target, reason: "submit", confidence: 1, expected_result: task.expectedResult, risk_level: "mutate" });
    expect(() => new VisualPolicy().check(action, before, { ...task, riskLevel: "mutate", permission: "OBSERVE" })).toThrow("does not allow");
    expect(() => new VisualPolicy().check({ ...action, risk_level: "interact" }, before, { ...task, surface: { ...task.surface, domain: "evil.example" } })).toThrow("not allowlisted");
  });

  it("blocks submission controls and Enter-like typing without an approved mutation", () => {
    const policy = new VisualPolicy();
    const saveClick = VisualAction.parse({
      action: "click", x: 10, y: 10, target: "Save budget", reason: "visible", confidence: 1,
      expected_result: task.expectedResult, risk_level: "interact"
    });
    expect(() => policy.check(saveClick, before, { ...task, target: "Save budget" })).toThrow("approved mutation plan");
    const newlineType = VisualAction.parse({
      action: "type", text: "120\n", target: "budget input", reason: "focused", confidence: 1,
      expected_result: "budget draft reads 120", risk_level: "interact"
    });
    expect(() => policy.check(newlineType, before, {
      ...task, target: "budget input", expectedResult: "budget draft reads 120", allowedActions: ["type", "done", "fail"]
    })).toThrow("cannot contain Enter");
    const enter = VisualAction.parse({
      action: "hotkey", keys: "ENTER", target: "budget input", reason: "submit", confidence: 1,
      expected_result: "submitted", risk_level: "interact"
    });
    expect(() => policy.check(enter, before, { ...task, target: "budget input", expectedResult: "submitted" })).toThrow("approved mutation plan");
  });

  it("requires an exact pre-authorized text payload before native typing", () => {
    const policy = new VisualPolicy();
    const type: Extract<VisualAction, { action: "type" }> = {
      action: "type",
      text: "120",
      target: "budget input",
      reason: "focused",
      confidence: 1,
      expected_result: "budget draft reads 120",
      risk_level: "interact"
    };
    const exactTask: VisualMicroTask = {
      ...task,
      target: "budget input",
      expectedResult: "budget draft reads 120",
      allowedActions: ["type", "fail"],
      allowedText: "120",
      retryPolicy: "none"
    };

    expect(() => policy.check(type, before, exactTask)).not.toThrow();
    expect(() => policy.check({ ...type, text: "999" }, before, exactTask)).toThrow(
      "typed text differs from this micro-task's exact allowlist"
    );
  });

  it("enforces a one-attempt action allowlist for scroll-only micro-tasks", async () => {
    let executions = 0;
    let groundings = 0;
    const runtime = new VisualComputerRuntime(
      { capture: async () => before, execute: async () => { executions += 1; } },
      {
        ground: async () => {
          groundings += 1;
          return {
            action: "click", x: 10, y: 10, target: "table body", reason: "wrong action", confidence: 1,
            expected_result: "the next table rows are visible", risk_level: "interact"
          };
        }
      },
      { verify: async () => ({ matched: false, confidence: 1, reason: "not reached" }) }
    );
    await expect(runtime.runMicroTask({
      ...task,
      instruction: "Scroll the visible table down exactly once",
      target: "table body",
      expectedResult: "the next table rows are visible",
      allowedActions: ["scroll", "done", "fail"],
      retryPolicy: "none"
    })).resolves.toMatchObject({ status: "failed", attempts: 1, blockerCode: "POLICY_BLOCKED" });
    expect(groundings).toBe(1);
    expect(executions).toBe(0);
  });

  it("requires a table scroll to use the allowed direction and visible in-region coordinates", () => {
    const allowedRegion = { x: 0, y: 0, width: 100, height: 100, coordinateSpace: "screenshot_pixels" as const };
    const tableTask: VisualMicroTask = {
      ...task,
      allowedRegion,
      allowedActions: ["scroll", "done", "fail"],
      allowedScrollDirections: ["down"]
    };
    const action = {
      action: "scroll" as const,
      direction: "right" as const,
      x: 20,
      y: 20,
      target: task.target,
      reason: "visible",
      confidence: 1,
      expected_result: task.expectedResult,
      risk_level: "interact" as const,
      allowedRegion
    };
    expect(() => new VisualPolicy().check(action, before, tableTask)).toThrow("scroll direction right");
    expect(() => new VisualPolicy().check({ ...action, direction: "down", x: undefined, y: undefined }, before, tableTask)).toThrow("requires visible in-region coordinates");
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

  it("repairs malformed Pi visual actions before returning a typed blocker", async () => {
    const faux = fauxProvider({ provider: "repair", models: [{ id: "fast", input: ["text", "image"] }, { id: "strong", input: ["text", "image"], reasoning: true }] });
    const models = createModels(); models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage('{"action":"click"}'),
      fauxAssistantMessage('{"action":"click","x":120,"y":80,"target":"date selector","reason":"visible","confidence":0.94,"expected_result":"date menu is open","risk_level":"interact"}')
    ]);
    const vision = new PiVisionModel(models, faux.getModel("fast")!, faux.getModel("strong")!);
    await expect(vision.ground(task, before, "gui")).resolves.toMatchObject({ action: "click", x: 120, y: 80 });

    faux.setResponses([fauxAssistantMessage("{}"), fauxAssistantMessage("{}"), fauxAssistantMessage("{}")]);
    await expect(vision.verify(task.expectedResult, before, after)).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
  });

  it("validates coordinates inside the captured active window", () => {
    const shot: Screenshot = { ...before, width: 1200, height: 800, surface: nativeSurface, surfaceFingerprint: fingerprintSurface(nativeSurface) };
    const action = VisualAction.parse({
      action: "click", x: 1100, y: 10, target: task.target, reason: "x", confidence: 1,
      expected_result: task.expectedResult, risk_level: "interact", surface_fingerprint: shot.surfaceFingerprint
    });
    expect(() => new VisualPolicy().check(action, shot, task)).toThrow("outside the active window");
  });

  it("blocks a surface switch before execution with a typed blocker", async () => {
    let executions = 0;
    const expected = fingerprintSurface(nativeSurface);
    const changed = fingerprintSurface({ ...nativeSurface, windowId: "8", title: "Unexpected dialog" });
    const shot: Screenshot = { ...before, surface: nativeSurface, surfaceFingerprint: expected };
    const operator: NativeOperator = {
      capture: async () => shot,
      identifySurface: async () => ({ surface: { ...nativeSurface, windowId: "8", title: "Unexpected dialog" }, fingerprint: changed }),
      execute: async () => { executions += 1; }
    };
    const runtime = new VisualComputerRuntime(operator, {
      ground: async () => ({ action: "click", x: 20, y: 20, target: "date selector", reason: "visible", confidence: 1, expected_result: task.expectedResult, risk_level: "interact" })
    }, { verify: async () => ({ matched: true, confidence: 1, reason: "open" }) });
    await expect(runtime.runMicroTask(task)).resolves.toMatchObject({ status: "failed", attempts: 1, blockerCode: "SURFACE_CHANGED" });
    expect(executions).toBe(0);
  });

  it.each([
    ["application", { ...nativeSurface, app: "Notes", bundleId: "com.apple.Notes" }],
    ["window bounds", { ...nativeSurface, bounds: { ...nativeSurface.bounds, x: 140 } }],
    ["DPI", { ...nativeSurface, scaleFactor: 1 }]
  ])("blocks changed %s before execution", async (_label, changedSurface) => {
    const shot: Screenshot = { ...before, surface: nativeSurface, surfaceFingerprint: fingerprintSurface(nativeSurface) };
    const runtime = new VisualComputerRuntime({
      capture: async () => shot,
      identifySurface: async () => ({ surface: changedSurface, fingerprint: fingerprintSurface(changedSurface) }),
      execute: async () => { throw new Error("must not execute"); }
    }, { ground: async () => ({ action: "click", x: 20, y: 20, target: "date selector", reason: "visible", confidence: 1, expected_result: task.expectedResult, risk_level: "interact" }) }, { verify: async () => ({ matched: true, confidence: 1, reason: "open" }) });
    await expect(runtime.runMicroTask(task)).resolves.toMatchObject({ status: "failed", blockerCode: "SURFACE_CHANGED" });
  });

  it("fails closed when the foreground application exits", async () => {
    const shot: Screenshot = { ...before, surface: nativeSurface, surfaceFingerprint: fingerprintSurface(nativeSurface) };
    const runtime = new VisualComputerRuntime({
      capture: async () => shot,
      identifySurface: async () => { throw new NativeSurfaceUnavailableError("foreground application exited"); },
      execute: async () => { throw new Error("must not execute"); }
    }, { ground: async () => ({ action: "click", x: 20, y: 20, target: "date selector", reason: "visible", confidence: 1, expected_result: task.expectedResult, risk_level: "interact" }) }, { verify: async () => ({ matched: true, confidence: 1, reason: "open" }) });
    await expect(runtime.runMicroTask(task)).resolves.toMatchObject({ status: "failed", attempts: 1, blockerCode: "SURFACE_CHANGED" });
  });

  it("honors user takeover before the next screenshot", async () => {
    let captures = 0;
    const runtime = new VisualComputerRuntime({ capture: async () => { captures += 1; return before; }, execute: async () => undefined }, {
      ground: async () => ({ action: "done", target: "task", reason: "done", confidence: 1, expected_result: "done", risk_level: "observe" })
    }, { verify: async () => ({ matched: true, confidence: 1, reason: "done" }) });
    expect(runtime.executionStatus()).toBe("running");
    runtime.pause();
    expect(runtime.executionStatus()).toBe("paused");
    await expect(runtime.runMicroTask(task)).resolves.toMatchObject({ status: "failed", blockerCode: "PAUSED" });
    expect(captures).toBe(0);
    runtime.resume();
    expect(runtime.executionStatus()).toBe("running");
    runtime.cancel();
    expect(runtime.executionStatus()).toBe("cancelled");
    runtime.resume();
    expect(runtime.executionStatus()).toBe("cancelled");
  });

  it.each(["pause", "takeover"] as const)(
    "interrupts pending grounding on %s and never reaches native input",
    async (control) => {
      let releaseGrounding!: (action: VisualAction) => void;
      let groundingStarted!: () => void;
      const started = new Promise<void>((resolve) => { groundingStarted = resolve; });
      const pending = new Promise<VisualAction>((resolve) => { releaseGrounding = resolve; });
      const execute = vi.fn(async () => undefined);
      const cancelPendingInput = vi.fn(async () => undefined);
      const runtime = new VisualComputerRuntime(
        { capture: async () => before, execute, cancelPendingInput },
        {
          ground: async () => {
            groundingStarted();
            return pending;
          }
        },
        { verify: async () => ({ matched: true, confidence: 1, reason: "not reached" }) }
      );
      const running = runtime.runMicroTask(task);
      await started;
      runtime[control]();
      releaseGrounding({
        action: "click",
        x: 20,
        y: 20,
        target: task.target,
        reason: "visible",
        confidence: 1,
        expected_result: task.expectedResult,
        risk_level: "interact"
      });
      await expect(running).resolves.toMatchObject({
        status: "failed",
        blockerCode: control === "pause" ? "PAUSED" : "USER_TAKEOVER"
      });
      expect(execute).not.toHaveBeenCalled();
      expect(cancelPendingInput).toHaveBeenCalledOnce();
    }
  );

  it("treats a throwing mutation executor as a single unknown attempt", async () => {
    const execute = vi.fn(async () => { throw new Error("helper disconnected"); });
    const runtime = new VisualComputerRuntime(
      { capture: async () => before, execute },
      { ground: async () => ({ action: "type", text: "120", target: "budget", reason: "focused", confidence: 1, expected_result: "draft is 120", risk_level: "mutate" }) },
      { verify: async () => ({ matched: false, confidence: 0, reason: "not reached" }) }
    );
    const mutationTask: VisualMicroTask = {
      ...task,
      target: "budget",
      expectedResult: "draft is 120",
      riskLevel: "mutate",
      permission: "MUTATE",
      planId: "plan-executor-disconnect",
      accountFingerprint: "c".repeat(64),
      allowedRegion: { x: 0, y: 0, width: before.width, height: before.height, coordinateSpace: "screenshot_pixels" }
    };
    await expect(runtime.runMicroTask(mutationTask)).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      blockerCode: "MUTATION_RETRY_FORBIDDEN",
      blocker: expect.stringContaining("outcome is unknown")
    });
    await expect(runtime.runMicroTask(mutationTask)).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      blockerCode: "DUPLICATE_MUTATION"
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("blocks a surface switch after execution without retrying the action", async () => {
    let captures = 0;
    let executions = 0;
    const firstFingerprint = fingerprintSurface(nativeSurface);
    const popup = { ...nativeSurface, windowId: "9", title: "Confirmation" };
    const popupFingerprint = fingerprintSurface(popup);
    const operator: NativeOperator = {
      capture: async () => {
        captures += 1;
        return captures === 1
          ? { ...before, surface: nativeSurface, surfaceFingerprint: firstFingerprint }
          : { ...after, surface: popup, surfaceFingerprint: popupFingerprint };
      },
      identifySurface: async () => ({ surface: nativeSurface, fingerprint: firstFingerprint }),
      execute: async () => { executions += 1; }
    };
    const runtime = new VisualComputerRuntime(operator, {
      ground: async () => ({ action: "click", x: 20, y: 20, target: "date selector", reason: "visible", confidence: 1, expected_result: task.expectedResult, risk_level: "interact" })
    }, { verify: async () => ({ matched: true, confidence: 1, reason: "open" }) });
    await expect(runtime.runMicroTask(task)).resolves.toMatchObject({ status: "failed", attempts: 1, blockerCode: "SURFACE_CHANGED" });
    expect(executions).toBe(1);
    expect(captures).toBe(2);
  });

  it("never retries a mutation or repeats the same coordinates", async () => {
    let mutationExecutions = 0;
    const mutationRuntime = new VisualComputerRuntime(
      { capture: async () => before, execute: async () => { mutationExecutions += 1; } },
      { ground: async () => ({ action: "type", text: "120", target: "budget", reason: "draft", confidence: 1, expected_result: "draft is 120", risk_level: "mutate" }) },
      { verify: async () => ({ matched: false, confidence: 1, reason: "not visible" }) }
    );
    await expect(mutationRuntime.runMicroTask({
      ...task,
      target: "budget",
      expectedResult: "draft is 120",
      riskLevel: "mutate",
      permission: "MUTATE",
      planId: "plan-budget-1",
      accountFingerprint: "c".repeat(64),
      allowedRegion: { x: 0, y: 0, width: before.width, height: before.height, coordinateSpace: "screenshot_pixels" }
    })).resolves.toMatchObject({
      status: "failed", attempts: 1, blockerCode: "MUTATION_RETRY_FORBIDDEN"
    });
    expect(mutationExecutions).toBe(1);

    let clickExecutions = 0;
    const duplicateRuntime = new VisualComputerRuntime(
      { capture: async () => before, execute: async () => { clickExecutions += 1; } },
      { ground: async () => ({ action: "click", x: 10, y: 10, target: "date selector", reason: "same", confidence: 1, expected_result: task.expectedResult, risk_level: "interact" }) },
      { verify: async () => ({ matched: false, confidence: 1, reason: "unchanged" }) }
    );
    await expect(duplicateRuntime.runMicroTask(task)).resolves.toMatchObject({ status: "failed", attempts: 2, blockerCode: "DUPLICATE_COORDINATE" });
    expect(clickExecutions).toBe(1);
  });

  it("never accepts a terminal done claim as proof that a mutation executed", async () => {
    let executions = 0;
    const runtime = new VisualComputerRuntime(
      { capture: async () => before, execute: async () => { executions += 1; } },
      {
        ground: async () => ({
          action: "done",
          target: "Save",
          reason: "the model claims the task is complete",
          confidence: 1,
          expected_result: "Saved",
          risk_level: "observe"
        })
      },
      { verify: async () => ({ matched: true, confidence: 1, reason: "not reached" }) }
    );
    await expect(runtime.runMicroTask({
      ...task,
      target: "Save",
      expectedResult: "Saved",
      riskLevel: "mutate",
      permission: "MUTATE",
      planId: "plan-terminal-done",
      accountFingerprint: "c".repeat(64),
      allowedRegion: { x: 0, y: 0, width: before.width, height: before.height, coordinateSpace: "screenshot_pixels" }
    })).resolves.toMatchObject({
      status: "failed",
      attempts: 1,
      blockerCode: "POLICY_BLOCKED",
      blocker: expect.stringContaining("cannot complete without a native action")
    });
    expect(executions).toBe(0);
  });

  it("blocks a mutation outside its approved region before native input", async () => {
    let executions = 0;
    const runtime = new VisualComputerRuntime(
      { capture: async () => before, execute: async () => { executions += 1; } },
      { ground: async () => ({ action: "click", x: 80, y: 80, target: "Save", reason: "visible", confidence: 1, expected_result: "Saved", risk_level: "mutate" }) },
      { verify: async () => ({ matched: true, confidence: 1, reason: "saved" }) }
    );
    await expect(runtime.runMicroTask({
      ...task,
      target: "Save",
      expectedResult: "Saved",
      riskLevel: "mutate",
      permission: "MUTATE",
      planId: "plan-1",
      accountFingerprint: "c".repeat(64),
      allowedRegion: { x: 0, y: 0, width: 40, height: 40, coordinateSpace: "screenshot_pixels" }
    })).resolves.toMatchObject({ status: "failed", attempts: 1, blockerCode: "POLICY_BLOCKED" });
    expect(executions).toBe(0);
  });

  it("recaptures and blocks if visible pixels change after mutation grounding", async () => {
    let captures = 0;
    let executions = 0;
    const runtime = new VisualComputerRuntime(
      {
        capture: async () => captures++ === 0 ? before : after,
        execute: async () => { executions += 1; }
      },
      { ground: async () => ({ action: "click", x: 20, y: 20, target: "Save", reason: "visible", confidence: 1, expected_result: "Saved", risk_level: "mutate" }) },
      { verify: async () => ({ matched: true, confidence: 1, reason: "saved" }) }
    );
    await expect(runtime.runMicroTask({
      ...task,
      target: "Save",
      expectedResult: "Saved",
      riskLevel: "mutate",
      permission: "MUTATE",
      planId: "plan-1",
      accountFingerprint: "c".repeat(64),
      allowedRegion: { x: 0, y: 0, width: 100, height: 100, coordinateSpace: "screenshot_pixels" }
    })).resolves.toMatchObject({ status: "failed", attempts: 1, blockerCode: "SURFACE_CHANGED" });
    expect(executions).toBe(0);
  });

  it("routes dedicated UI-TARS first and PiVision only as fallback", async () => {
    const events: string[] = [];
    const dedicated: VisualGroundingProvider = {
      id: "dedicated", kind: "dedicated", ground: async () => { throw new Error("offline"); }
    };
    const fallback: VisualGroundingProvider = {
      id: "pi", kind: "pi-vision",
      ground: async () => ({ action: "done", target: "task", reason: "visible", confidence: 1, expected_result: "done", risk_level: "observe" })
    };
    const router = new GuiGroundingProviderRouter(dedicated, fallback, (event) => { events.push(`${event.provider}:${event.outcome}`); });
    await expect(router.ground(task, before, "gui")).resolves.toMatchObject({ action: "done" });
    expect(events).toEqual(["dedicated:failed", "pi:selected"]);
  });

  it("calls a dedicated OpenAI-compatible UI-TARS endpoint and parses one action", async () => {
    const image = await new Jimp({ width: 20, height: 10, color: 0xffffffff }).getBuffer("image/png");
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string }> };
      expect(payload.model).toBe("ui-tars-strong");
      expect(payload.messages.map((message) => message.role)).toEqual(["system", "user"]);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Thought: visible target\nAction: click(start_box='[100,200,100,200]')" } }] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    });
    const provider = new OpenAICompatibleUiTarsProvider({
      baseURL: "https://grounding.example/v1", apiKey: "secret", model: "ui-tars", strongModel: "ui-tars-strong", fetch: request as typeof fetch
    });
    const shot: Screenshot = { ...before, base64: image.toString("base64") };
    await expect(provider.ground({ ...task, taskId: "task-1", stepId: "step-1" }, shot, "strong")).resolves.toMatchObject({ action: "click", target: "date selector" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("adapts normalized JSON actions from a custom OpenAI-compatible GUI provider", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"action":"click","x":0.5,"y":0.25,"target":"date selector","reason":"visible","confidence":0.9,"expected_result":"open","risk_level":"interact"}' } }] }), { status: 200 }));
    const provider = new OpenAICompatibleUiTarsProvider({
      baseURL: "https://custom.example/v1", model: "gui-json", protocol: "adpilot-json",
      coordinateFormat: "normalized", fetch: request as typeof fetch
    });
    const image = await new Jimp({ width: 20, height: 10, color: 0xffffffff }).getBuffer("image/png");
    const shot: Screenshot = { ...before, base64: image.toString("base64") };
    await expect(provider.ground(task, shot, "gui")).resolves.toMatchObject({ action: "click", x: 500, y: 200 });
  });

  it("uses native macOS surface probing before AppleScript fallback", async () => {
    const fallback = vi.fn(async () => ({ ...nativeSurface, title: "fallback" }));
    const native = vi.fn(async () => nativeSurface);
    const identity = new MacOSNativeSurfaceIdentity(native, fallback);
    await expect(identity.identifyActiveSurface()).resolves.toEqual(nativeSurface);
    expect(fallback).not.toHaveBeenCalled();

    const fallbackIdentity = new MacOSNativeSurfaceIdentity(async () => { throw new Error("native unavailable"); }, fallback);
    await expect(fallbackIdentity.identifyActiveSurface()).resolves.toMatchObject({ title: "fallback" });
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("captures an active window and translates window pixels to global native coordinates", async () => {
    const image = await new Jimp({ width: 40, height: 20, color: 0xffffffff }).getBuffer("image/png");
    const identity: NativeSurfaceIdentity = {
      identifyActiveSurface: async () => nativeSurface,
      captureActiveWindow: async () => ({
        base64: image.toString("base64"), width: 40, height: 20, scaleFactor: 2,
        surface: nativeSurface, surfaceFingerprint: fingerprintSurface(nativeSurface)
      })
    };
    const execute = vi.fn(async (_params: unknown) => undefined);
    const native = new UiTarsNativeOperator({ execute, screenshot: vi.fn() } as never, identity);
    const shot = await native.capture();
    expect(shot.sha256).toBe(createHash("sha256").update(image).digest("hex"));
    await native.execute(VisualAction.parse({
      action: "click", x: 20, y: 10, target: "x", reason: "visible", confidence: 1,
      expected_result: "clicked", risk_level: "interact"
    }), shot);
    const params = execute.mock.calls[0]?.[0] as { parsedPrediction: { action_inputs: { start_box: string } }; screenWidth: number };
    expect(params.screenWidth).toBe(40);
    expect(params.parsedPrediction.action_inputs.start_box).toBe("[2.75,2.75,2.75,2.75]");
  });
});
