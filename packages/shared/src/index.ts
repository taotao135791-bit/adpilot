import { z } from "zod";

export const PermissionLevel = z.enum(["OBSERVE", "INTERACT", "MUTATE", "DESTRUCTIVE"]);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

export const RiskLevel = z.enum(["observe", "interact", "mutate", "destructive"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const Platform = z.enum([
  "google_ads",
  "meta_ads",
  "tiktok_ads",
  "apple_ads",
  "microsoft_ads",
  "amazon_ads",
  "linkedin_ads",
  "youtube_ads",
  "other"
]);
export type Platform = z.infer<typeof Platform>;

export const Evidence = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  observedAt: z.string().datetime(),
  kind: z.enum(["screenshot", "export", "workspace", "calculation", "user", "system"]),
  summary: z.string().min(1),
  uri: z.string().optional(),
  facts: z.record(z.unknown()).default({})
});
export type Evidence = z.infer<typeof Evidence>;

export const TaskPhase = z.enum([
  "intake",
  "investigating",
  "analyzing",
  "reviewing_risk",
  "awaiting_approval",
  "executing",
  "verifying",
  "monitoring",
  "completed",
  "blocked",
  "cancelled"
]);

export const SpecialistRole = z.enum([
  "account_operator",
  "performance_analyst",
  "media_buyer",
  "measurement_reviewer",
  "creative_strategist",
  "risk_reviewer"
]);
export type SpecialistRole = z.infer<typeof SpecialistRole>;

export const TaskState = z.object({
  id: z.string().uuid(),
  clientId: z.string().min(1),
  goal: z.string().min(1),
  phase: TaskPhase,
  completedSteps: z.array(z.string()).default([]),
  evidence: z.array(Evidence).default([]),
  hypotheses: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  nextStep: z.string().nullable().default(null),
  owner: SpecialistRole.nullable().default(null),
  reviewAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type TaskState = z.infer<typeof TaskState>;

export const ModelTier = z.enum(["fast", "gui", "strong"]);
export type ModelTier = z.infer<typeof ModelTier>;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function assertSafeIdentifier(value: string, label = "identifier"): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, underscores, or hyphens`);
  }
  return value;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

