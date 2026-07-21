import { createHash } from "node:crypto";
import { Jimp } from "jimp";
import { NutJSOperator } from "@ui-tars/operator-nut-js";
import { UITarsModel, parseBoxToScreenCoords, type ScreenshotOutput } from "@ui-tars/sdk/core";
import { UITarsModelVersion } from "@ui-tars/sdk";
import { z } from "zod";
import { PermissionLevel, RiskLevel, type ModelTier, type PermissionLevel as Permission } from "@adpilot/shared";

const common = {
  target: z.string().min(1),
  reason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  expected_result: z.string().min(1),
  risk_level: RiskLevel
};

const coordinate = { x: z.number().nonnegative(), y: z.number().nonnegative() };

export const VisualAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("click"), ...coordinate, ...common }),
  z.object({ action: z.literal("double_click"), ...coordinate, ...common }),
  z.object({ action: z.literal("right_click"), ...coordinate, ...common }),
  z.object({ action: z.literal("move"), ...coordinate, ...common }),
  z.object({ action: z.literal("drag"), ...coordinate, end_x: z.number().nonnegative(), end_y: z.number().nonnegative(), ...common }),
  z.object({ action: z.literal("type"), text: z.string().min(1), ...common }),
  z.object({ action: z.literal("hotkey"), keys: z.string().min(1), ...common }),
  z.object({ action: z.literal("scroll"), direction: z.enum(["up", "down", "left", "right"]), x: z.number().nonnegative().optional(), y: z.number().nonnegative().optional(), ...common }),
  z.object({ action: z.literal("wait"), milliseconds: z.number().int().min(100).max(10_000).default(1000), ...common }),
  z.object({ action: z.literal("screenshot"), ...common }),
  z.object({ action: z.literal("done"), ...common }),
  z.object({ action: z.literal("fail"), ...common })
]);
export type VisualAction = z.infer<typeof VisualAction>;

export const Screenshot = z.object({
  base64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scaleFactor: z.number().positive(),
  capturedAt: z.string().datetime(),
  sha256: z.string().length(64)
});
export type Screenshot = z.infer<typeof Screenshot>;

export interface SurfaceContext {
  app: string;
  domain?: string;
  allowedApps: string[];
  allowedDomains: string[];
}

export interface VisualMicroTask {
  instruction: string;
  target: string;
  expectedResult: string;
  riskLevel: z.infer<typeof RiskLevel>;
  permission: Permission;
  surface: SurfaceContext;
}

export interface GroundingModel {
  ground(task: VisualMicroTask, screenshot: Screenshot, tier: ModelTier): Promise<VisualAction>;
}

export interface VisualVerifier {
  verify(expectedResult: string, before: Screenshot, after: Screenshot): Promise<{ matched: boolean; confidence: number; reason: string }>;
}

export interface NativeOperator {
  capture(): Promise<Screenshot>;
  execute(action: VisualAction, screenshot: Screenshot): Promise<void>;
}

export type VisualRuntimeEvent =
  | { type: "screenshot"; phase: "before" | "after"; screenshot: Screenshot }
  | { type: "grounded"; attempt: number; tier: ModelTier; action: VisualAction }
  | { type: "executed"; attempt: number; action: VisualAction }
  | { type: "verified"; attempt: number; matched: boolean; confidence: number; reason: string }
  | { type: "blocked"; attempt: number; reason: string };

export type VisualStepResult =
  | { status: "done"; attempts: number; action: VisualAction; before: Screenshot; after: Screenshot }
  | { status: "failed"; attempts: number; blocker: string; lastAction?: VisualAction };

export class VisualPolicy {
  check(action: VisualAction, screenshot: Screenshot, task: VisualMicroTask): void {
    this.checkSurface(task.surface);
    const permission = PermissionLevel.parse(task.permission);
    const permissionRank = { OBSERVE: 0, INTERACT: 1, MUTATE: 2, DESTRUCTIVE: 3 } as const;
    const riskPermission = { observe: "OBSERVE", interact: "INTERACT", mutate: "MUTATE", destructive: "DESTRUCTIVE" } as const;
    if (permissionRank[permission] < permissionRank[riskPermission[action.risk_level]]) {
      throw new Error(`${permission} does not allow ${action.risk_level} action`);
    }
    const terminalOrUtility = ["done", "fail", "screenshot", "wait"].includes(action.action);
    if (!terminalOrUtility && action.risk_level !== task.riskLevel) throw new Error("grounded action changed the declared risk level");
    const points: Array<[number, number]> = [];
    if ("x" in action && action.x !== undefined && "y" in action && action.y !== undefined) points.push([action.x, action.y]);
    if (action.action === "drag") points.push([action.end_x, action.end_y]);
    for (const [x, y] of points) {
      if (x < 0 || y < 0 || x >= screenshot.width || y >= screenshot.height) throw new Error("action coordinates are outside the screenshot");
    }
    if (terminalOrUtility && action.risk_level !== "observe") {
      throw new Error(`${action.action} must be observe risk`);
    }
  }

  private checkSurface(surface: SurfaceContext): void {
    if (!surface.allowedApps.includes(surface.app)) throw new Error(`application is not allowlisted: ${surface.app}`);
    if (surface.domain) {
      const domain = surface.domain.toLowerCase();
      const allowed = surface.allowedDomains.some((candidate) => domain === candidate.toLowerCase() || domain.endsWith(`.${candidate.toLowerCase()}`));
      if (!allowed) throw new Error(`domain is not allowlisted: ${surface.domain}`);
    }
  }
}

export class VisualComputerRuntime {
  private paused = false;
  private cancelled = false;

  constructor(
    private readonly operator: NativeOperator,
    private readonly grounding: GroundingModel,
    private readonly verifier: VisualVerifier,
    private readonly policy = new VisualPolicy(),
    private readonly onEvent: (event: VisualRuntimeEvent) => void | Promise<void> = () => undefined,
    private readonly stepTimeoutMs = 20_000
  ) {}

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  cancel(): void { this.cancelled = true; }

  async runMicroTask(task: VisualMicroTask): Promise<VisualStepResult> {
    let lastAction: VisualAction | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (this.cancelled) return { status: "failed", attempts: attempt - 1, blocker: "user cancelled", ...(lastAction ? { lastAction } : {}) };
      if (this.paused) return { status: "failed", attempts: attempt - 1, blocker: "paused for user takeover", ...(lastAction ? { lastAction } : {}) };
      const tier: ModelTier = attempt >= 3 ? "strong" : "gui";
      try {
        const before = await withTimeout(this.operator.capture(), this.stepTimeoutMs, "screenshot capture");
        await this.onEvent({ type: "screenshot", phase: "before", screenshot: before });
        const action = VisualAction.parse(await withTimeout(this.grounding.ground(task, before, tier), this.stepTimeoutMs, "visual grounding"));
        lastAction = action;
        this.policy.check(action, before, task);
        await this.onEvent({ type: "grounded", attempt, tier, action });
        if (action.action === "fail") return { status: "failed", attempts: attempt, blocker: action.reason, lastAction: action };
        if (action.action === "done") return { status: "done", attempts: attempt, action, before, after: before };
        await withTimeout(this.operator.execute(action, before), this.stepTimeoutMs, "native action");
        await this.onEvent({ type: "executed", attempt, action });
        const after = await withTimeout(this.operator.capture(), this.stepTimeoutMs, "verification screenshot");
        await this.onEvent({ type: "screenshot", phase: "after", screenshot: after });
        const verified = await withTimeout(this.verifier.verify(action.expected_result, before, after), this.stepTimeoutMs, "visual verification");
        await this.onEvent({ type: "verified", attempt, ...verified });
        if (verified.matched) return { status: "done", attempts: attempt, action, before, after };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.onEvent({ type: "blocked", attempt, reason });
        if (error instanceof VisualTimeoutError) {
          return { status: "failed", attempts: attempt, blocker: `${reason}; stopped to avoid a duplicate or blind action`, ...(lastAction ? { lastAction } : {}) };
        }
      }
    }
    return { status: "failed", attempts: 3, blocker: "visual action failed three times; blind operation stopped", ...(lastAction ? { lastAction } : {}) };
  }
}

class VisualTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new VisualTimeoutError(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class UiTarsNativeOperator implements NativeOperator {
  constructor(private readonly operator = new NutJSOperator()) {}

  async capture(): Promise<Screenshot> {
    const raw = await this.operator.screenshot();
    const image = await Jimp.fromBuffer(Buffer.from(raw.base64.replace(/^data:image\/\w+;base64,/, ""), "base64"));
    return Screenshot.parse({
      base64: raw.base64.replace(/^data:image\/\w+;base64,/, ""),
      width: image.width,
      height: image.height,
      scaleFactor: raw.scaleFactor,
      capturedAt: new Date().toISOString(),
      sha256: createHash("sha256").update(raw.base64).digest("hex")
    });
  }

  async execute(action: VisualAction, screenshot: Screenshot): Promise<void> {
    if (action.action === "screenshot") return;
    if (action.action === "wait") {
      await new Promise((resolve) => setTimeout(resolve, action.milliseconds));
      return;
    }
    if (action.action === "done" || action.action === "fail") return;
    const startBox = "x" in action && action.x !== undefined && "y" in action && action.y !== undefined
      ? normalizedBox(action.x, action.y, screenshot)
      : "";
    const endBox = action.action === "drag" ? normalizedBox(action.end_x, action.end_y, screenshot) : undefined;
    const actionType = ({ double_click: "left_double", right_click: "right_single", move: "mouse_move" } as Record<string, string>)[action.action] ?? action.action;
    const actionInputs: Record<string, string> = {};
    if (startBox) actionInputs.start_box = startBox;
    if (endBox) actionInputs.end_box = endBox;
    if (action.action === "type") actionInputs.content = action.text;
    if (action.action === "hotkey") actionInputs.key = action.keys;
    if (action.action === "scroll") actionInputs.direction = action.direction;
    await this.operator.execute({
      prediction: `${actionType}()`,
      parsedPrediction: { action_type: actionType, action_inputs: actionInputs, reflection: null, thought: action.reason },
      screenWidth: screenshot.width,
      screenHeight: screenshot.height,
      scaleFactor: screenshot.scaleFactor,
      factors: [1000, 1000]
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
}

function normalizedBox(x: number, y: number, screenshot: Screenshot): string {
  return `[${x / screenshot.width},${y / screenshot.height},${x / screenshot.width},${y / screenshot.height}]`;
}

export class UiTarsGroundingModel implements GroundingModel {
  private readonly model: UITarsModel;
  private readonly strongModel: UITarsModel;

  constructor(config: { apiKey: string; baseURL: string; model: string; strongModel?: string }) {
    if (!config.apiKey || !config.baseURL || !config.model) throw new Error("GUI grounding model is not configured");
    this.model = new UITarsModel({ ...config, temperature: 0, max_tokens: 1000 });
    this.strongModel = new UITarsModel({ ...config, model: config.strongModel ?? config.model, temperature: 0, max_tokens: 1000 });
  }

  async ground(task: VisualMicroTask, screenshot: Screenshot, tier: ModelTier): Promise<VisualAction> {
    const instruction = [
      "Plan exactly one immediate GUI micro-action. Do not plan the overall advertising task.",
      `Instruction: ${task.instruction}`,
      `Target: ${task.target}`,
      `Expected result: ${task.expectedResult}`
    ].join("\n");
    const output = await (tier === "strong" ? this.strongModel : this.model).invoke({
      conversations: [{ from: "human", value: instruction }, { from: "human", value: "<image>" }],
      images: [screenshot.base64],
      screenContext: { width: screenshot.width, height: screenshot.height },
      scaleFactor: screenshot.scaleFactor,
      uiTarsVersion: UITarsModelVersion.V1_5
    });
    if (output.parsedPredictions.length !== 1) throw new Error("grounding model must return exactly one action");
    const parsed = output.parsedPredictions[0];
    if (!parsed) throw new Error("grounding model returned no action");
    return mapGroundedAction(parsed, screenshot, task);
  }
}

function mapGroundedAction(parsed: { action_type: string; action_inputs: Record<string, unknown>; thought: string; reflection: string | null }, screenshot: Screenshot, task: VisualMicroTask): VisualAction {
  const typeMap: Record<string, VisualAction["action"]> = {
    left_click: "click", left_single: "click", click: "click",
    left_double: "double_click", double_click: "double_click",
    right_single: "right_click", right_click: "right_click",
    mouse_move: "move", hover: "move", drag: "drag", left_click_drag: "drag",
    type: "type", hotkey: "hotkey", scroll: "scroll", wait: "wait",
    finished: "done", call_user: "fail", error_env: "fail"
  };
  const action = typeMap[parsed.action_type];
  if (!action) throw new Error(`unsupported grounding action: ${parsed.action_type}`);
  const base = {
    action,
    target: task.target,
    reason: parsed.thought || parsed.reflection || "grounded visual action",
    confidence: 0.8,
    expected_result: task.expectedResult,
    risk_level: action === "done" || action === "fail" || action === "wait" ? "observe" as const : task.riskLevel
  };
  if (["click", "double_click", "right_click", "move", "drag"].includes(action)) {
    const point = parseBoxToScreenCoords({ boxStr: String(parsed.action_inputs.start_box ?? ""), screenWidth: screenshot.width, screenHeight: screenshot.height });
    if (point.x === null || point.y === null) throw new Error("grounding action has no coordinates");
    if (action === "drag") {
      const end = parseBoxToScreenCoords({ boxStr: String(parsed.action_inputs.end_box ?? ""), screenWidth: screenshot.width, screenHeight: screenshot.height });
      if (end.x === null || end.y === null) throw new Error("drag action has no destination");
      return VisualAction.parse({ ...base, x: point.x, y: point.y, end_x: end.x, end_y: end.y });
    }
    return VisualAction.parse({ ...base, x: point.x, y: point.y });
  }
  if (action === "type") return VisualAction.parse({ ...base, text: String(parsed.action_inputs.content ?? "") });
  if (action === "hotkey") return VisualAction.parse({ ...base, keys: String(parsed.action_inputs.key ?? parsed.action_inputs.hotkey ?? "") });
  if (action === "scroll") return VisualAction.parse({ ...base, direction: String(parsed.action_inputs.direction ?? "down").toLowerCase() });
  if (action === "wait") return VisualAction.parse({ ...base, milliseconds: 1000 });
  return VisualAction.parse(base);
}

export class ImageChangeVerifier implements VisualVerifier {
  async verify(expectedResult: string, before: Screenshot, after: Screenshot): Promise<{ matched: boolean; confidence: number; reason: string }> {
    const changed = before.sha256 !== after.sha256;
    return { matched: changed, confidence: changed ? 0.51 : 1, reason: changed ? `screen changed after: ${expectedResult}` : "screen did not change" };
  }
}

export class OpenAICompatibleVisualVerifier implements VisualVerifier {
  constructor(private readonly config: { apiKey: string; baseURL: string; model: string }) {}

  async verify(expectedResult: string, before: Screenshot, after: Screenshot): Promise<{ matched: boolean; confidence: number; reason: string }> {
    const response = await fetch(`${this.config.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({
        model: this.config.model, temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: [
          { type: "text", text: `Did the AFTER screenshot satisfy this expected result: ${expectedResult}? Return JSON only: {\"matched\":boolean,\"confidence\":number,\"reason\":string}.` },
          { type: "text", text: "BEFORE" }, { type: "image_url", image_url: { url: `data:image/png;base64,${before.base64}` } },
          { type: "text", text: "AFTER" }, { type: "image_url", image_url: { url: `data:image/png;base64,${after.base64}` } }
        ] }]
      })
    });
    if (!response.ok) throw new Error(`visual verification failed: HTTP ${response.status}`);
    const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const parsed = z.object({ matched: z.boolean(), confidence: z.number().min(0).max(1), reason: z.string().min(1) }).parse(JSON.parse(body.choices?.[0]?.message?.content ?? ""));
    return parsed;
  }
}

export function assertScreenshotOutput(value: ScreenshotOutput): ScreenshotOutput {
  if (!value.base64 || !Number.isFinite(value.scaleFactor) || value.scaleFactor <= 0) throw new Error("invalid native screenshot");
  return value;
}
