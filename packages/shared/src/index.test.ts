import { describe, expect, it } from "vitest";
import {
  assertSafeIdentifier,
  classifyToolCall,
  CustomProviderConfig,
  extractApprovalCredentials,
  InMemorySharedFactRepository,
  isLocalHostname,
  isLocalModelEndpoint,
  migrateLegacyFactDispatch,
  PermissionLevel,
  SharedFact,
  SharedFactLedger,
  SharedFactStatus,
  stableJson,
  TaskState,
  TOOL_GATE_RULES
} from "./index.js";

describe("shared contracts", () => {
  it("accepts only explicit permission levels", () => {
    expect(PermissionLevel.parse("OBSERVE")).toBe("OBSERVE");
    expect(() => PermissionLevel.parse("ADMIN")).toThrow();
  });

  it("prevents workspace path traversal", () => {
    expect(assertSafeIdentifier("client_01-prod")).toBe("client_01-prod");
    expect(() => assertSafeIdentifier("../other-client")).toThrow();
  });

  it("serializes equivalent objects deterministically", () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it("rejects incomplete task state", () => {
    expect(() => TaskState.parse({ goal: "Improve CPA" })).toThrow();
  });

  it("defines the complete shared-fact lifecycle and verifier contract", () => {
    expect(SharedFactStatus.options).toEqual([
      "hypothesis", "observed", "verified", "rejected", "stale", "superseded"
    ]);
    const taskId = crypto.randomUUID();
    expect(SharedFact.parse({
      factId: "measurement.purchase_count",
      clientId: "client-a",
      taskId,
      subject: "campaign-a",
      predicate: "purchase_count",
      value: 42,
      unit: "conversions",
      sourceType: "visual_table",
      sourceScreenshotId: "screen-1",
      sourceBoundingBox: [10, 20, 30, 40],
      evidenceIds: ["screenshot:screen-1"],
      confidence: 0.98,
      status: "verified",
      createdBy: "visual_table_reader",
      verifiedBy: ["visual_verifier"],
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:01.000Z",
      verifiedAt: "2026-07-22T00:00:01.000Z",
      expiresAt: null
    })).toMatchObject({ taskId, status: "verified", value: 42, sourceScreenshotId: "screen-1" });
    expect(() => SharedFact.parse({
      factId: "measurement.purchase_count",
      clientId: "client-a",
      taskId,
      subject: "campaign-a",
      predicate: "purchase_count",
      value: 42,
      unit: "conversions",
      sourceType: "visual_table",
      sourceScreenshotId: "screen-1",
      sourceBoundingBox: [10, 20, 30, 40],
      confidence: 0.98,
      status: "verified",
      createdBy: "visual_table_reader",
      verifiedBy: [],
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:01.000Z",
      expiresAt: null
    })).toThrow("verified facts require at least one verifier");
  });

  it("moves observed facts through verified, superseded, stale, and expiry states", async () => {
    let now = new Date("2026-07-22T00:00:00.000Z");
    const repository = new InMemorySharedFactRepository();
    const ledger = new SharedFactLedger(repository, { now: () => now });
    const taskId = crypto.randomUUID();
    const draft = {
      clientId: "client-a", taskId, subject: "campaign-a", predicate: "daily_budget", value: 100, unit: "USD",
      sourceType: "visual_table" as const, sourceScreenshotId: "screen-1", sourceBoundingBox: [10, 20, 30, 40] as [number, number, number, number],
      evidenceIds: ["screenshot:screen-1"], confidence: 0.96, createdBy: "visual_table_reader", expiresAt: "2026-07-22T00:10:00.000Z"
    };
    const first = await ledger.observe(draft);
    expect(first.status).toBe("observed");
    const verified = await ledger.verify("client-a", first.factId, { verifier: "visual_verifier", confidence: 0.93 });
    expect(verified).toMatchObject({ status: "verified", verifiedBy: ["visual_verifier"] });
    expect(await ledger.usable("client-a", { taskId })).toHaveLength(1);

    now = new Date("2026-07-22T00:01:00.000Z");
    const second = await ledger.observe({ ...draft, sourceScreenshotId: "screen-2", evidenceIds: ["screenshot:screen-2"], value: 110 });
    await ledger.verify("client-a", second.factId, { verifier: "visual_verifier", confidence: 0.94 });
    const afterReplacement = await ledger.list("client-a", { taskId, includeTerminal: true });
    expect(afterReplacement.find((fact) => fact.factId === first.factId)).toMatchObject({ status: "superseded", supersededByFactId: second.factId });

    now = new Date("2026-07-22T00:11:00.000Z");
    expect(await ledger.usable("client-a", { taskId })).toHaveLength(0);
    expect((await ledger.list("client-a", { taskId, includeTerminal: true })).find((fact) => fact.factId === second.factId)).toMatchObject({ status: "stale", statusReason: "fact expired" });
  });

  it("marks a previously verified fact stale when its visual surface changes", async () => {
    const ledger = new SharedFactLedger();
    const taskId = crypto.randomUUID();
    const observed = await ledger.observe({
      clientId: "client-a", taskId, subject: "campaign-a", predicate: "bid", value: 2.5, unit: "USD",
      sourceType: "visual_table", sourceScreenshotId: "screen-1", sourceBoundingBox: [10, 20, 30, 40],
      evidenceIds: ["screenshot:screen-1"], confidence: 0.96, createdBy: "visual_table_reader", expiresAt: null
    });
    await ledger.verify("client-a", observed.factId, { verifier: "visual_verifier", confidence: 0.95 });
    const [stale] = await ledger.invalidateVisualEvidence("client-a", {
      taskId, sourceScreenshotIds: ["screen-1"], reason: "bound browser surface changed"
    });
    expect(stale).toMatchObject({ status: "stale", statusReason: "bound browser surface changed" });
    expect(await ledger.usable("client-a", { taskId })).toEqual([]);
  });

  it("keeps legacy fact dispatch in a migration-only observed state", async () => {
    const taskId = crypto.randomUUID();
    const migrated = migrateLegacyFactDispatch({ targetCpa: 10, messages: ["private transcript"] }, {
      clientId: "client-a", taskId, now: "2026-07-22T00:00:00.000Z"
    });
    expect(migrated).toHaveLength(1);
    expect(migrated[0]).toMatchObject({ factId: "legacy.targetCpa", sourceType: "migration", status: "observed", value: 10 });
    const ledger = new SharedFactLedger();
    await ledger.observe({
      clientId: "client-a", taskId, subject: "legacy", predicate: "value", value: 10, unit: "",
      sourceType: "migration", sourceScreenshotId: null, sourceBoundingBox: null, evidenceIds: [], confidence: 0.5,
      createdBy: "migration", expiresAt: null
    });
    const stored = await ledger.list("client-a", { taskId });
    await expect(ledger.verify("client-a", stored[0]!.factId, { verifier: "reviewer", confidence: 0.9 })).rejects.toThrow("cannot enter");
    expect(await ledger.usable("client-a", { taskId })).toEqual([]);
  });
});

describe("custom provider contracts", () => {
  it("validates custom provider configs and applies defaults", () => {
    const parsed = CustomProviderConfig.parse({
      id: "corp-gateway", name: "Corp Gateway", baseUrl: "https://gateway.corp.example/v1",
      models: [{ id: "gpt-4o-internal" }]
    });
    expect(parsed.api).toBe("openai-completions");
    expect(parsed.models[0]).toEqual({ id: "gpt-4o-internal", vision: false });
    expect(parsed.apiKey).toBeUndefined();
  });

  it("rejects invalid baseUrls, bad ids, and empty model lists", () => {
    const base = { id: "corp-gateway", name: "Corp", models: [{ id: "m" }] };
    expect(() => CustomProviderConfig.parse({ ...base, baseUrl: "not-a-url" })).toThrow("baseUrl");
    expect(() => CustomProviderConfig.parse({ ...base, baseUrl: "ftp://files.example/v1" })).toThrow("baseUrl");
    expect(() => CustomProviderConfig.parse({ ...base, baseUrl: "https://ok.example/v1", id: "Bad_Id" })).toThrow("slug");
    expect(() => CustomProviderConfig.parse({ ...base, baseUrl: "https://ok.example/v1", models: [] })).toThrow();
    expect(() => CustomProviderConfig.parse({ ...base, baseUrl: "https://ok.example/v1", apiKey: "" })).toThrow();
  });

  it("classifies loopback and private hosts as local", () => {
    for (const host of ["localhost", "api.localhost", "127.0.0.1", "127.0.1.20", "[::1]", "[::ffff:127.0.0.1]", "0.0.0.0",
      "10.0.0.8", "172.16.3.4", "172.31.255.255", "192.168.1.10", "169.254.1.1", "[fe80::1]", "[fd00::8]", "nas.local", "gateway.internal"]) {
      expect(isLocalHostname(host), host).toBe(true);
    }
    for (const host of ["api.openai.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "193.168.1.1", "localhost.example.com", "[2001:4860:4860::8888]"]) {
      expect(isLocalHostname(host), host).toBe(false);
    }
  });

  it("classifies model endpoints by provider id or baseUrl, defaulting to remote", () => {
    expect(isLocalModelEndpoint("ollama")).toBe(true);
    expect(isLocalModelEndpoint("my-llama.cpp-box")).toBe(true);
    expect(isLocalModelEndpoint("corp-gateway", "https://gateway.corp.example/v1")).toBe(false);
    expect(isLocalModelEndpoint("corp-gateway", "http://192.168.20.5:8000/v1")).toBe(true);
    expect(isLocalModelEndpoint("corp-gateway", "http://[::1]:8080/v1")).toBe(true);
    expect(isLocalModelEndpoint("openai", "https://api.openai.com/v1")).toBe(false);
    expect(isLocalModelEndpoint("openai")).toBe(false);
    expect(isLocalModelEndpoint("broken", "://not a url")).toBe(false);
  });
});

describe("tool permission gate table", () => {
  it("classifies every read tool the specialists rely on as read", () => {
    for (const name of ["read_workspace", "analyze_campaign_metrics", "evaluate_change_guardrail", "read_visual_table"]) {
      expect(classifyToolCall(name, {}).class, name).toBe("read");
    }
    expect(classifyToolCall("dispatch_specialist", { role: "performance_analyst", input: {} }).class).toBe("read");
    expect(classifyToolCall("dispatch_specialist", { role: "account_operator", input: { visualTask: { permission: "INTERACT" } } }).class).toBe("read");
    for (const skill of ["detect-creative-fatigue", "daily-report", "weekly-report", "account-audit", "check-conversion-reliability"]) {
      expect(classifyToolCall("execute_skill", { name: skill, input: {} }).class, skill).toBe("read");
    }
  });

  it("classifies the vendored general read-only tools as read, never defaulted", () => {
    for (const name of ["read", "grep", "find", "ls"]) {
      const classification = classifyToolCall(name, {});
      expect(classification.class, name).toBe("read");
      expect(classification.defaulted, name).toBe(false);
      expect(classification.rule.authority, name).toBe("self_gated");
    }
  });

  it("escalates mutation-shaped calls to write or destructive", () => {
    expect(classifyToolCall("dispatch_specialist", { role: "account_operator", input: { visualTask: { permission: "MUTATE" } } }).class).toBe("destructive");
    expect(classifyToolCall("dispatch_specialist", { role: "account_operator", input: { visualTask: { permission: "DESTRUCTIVE" } } }).class).toBe("destructive");
    expect(classifyToolCall("execute_skill", { name: "create-single-variable-experiment", input: {} }).class).toBe("write");
    expect(classifyToolCall("execute_skill", { name: "not-a-real-skill", input: {} }).class).toBe("write");
    expect(classifyToolCall("prepare_approval", {}).class).toBe("write");
    expect(classifyToolCall("commit_approved_action", {}).class).toBe("destructive");
  });

  it("fails closed on unclassified tools: unknown names are approval-gated writes, never reads", () => {
    const classification = classifyToolCall("brand_new_tool", {});
    expect(classification.defaulted).toBe(true);
    expect(classification.class).toBe("write");
    expect(classification.rule.authority).toBe("approval_token");
    expect(classifyToolCall("read_workspace", {}).defaulted).toBe(false);
  });

  it("covers every Pi tool name with a rule that has a reason", () => {
    for (const name of ["read_workspace", "analyze_campaign_metrics", "evaluate_change_guardrail", "read_visual_table",
      "read", "grep", "find", "ls",
      "dispatch_specialist", "prepare_approval", "execute_skill", "commit_approved_action"]) {
      expect(TOOL_GATE_RULES[name]?.reason.length, name).toBeGreaterThan(0);
    }
  });

  it("extracts approval credentials from top-level and execute_skill input arguments", () => {
    const id = crypto.randomUUID();
    expect(extractApprovalCredentials({ approvalId: id, approvalToken: "a.b.c" })).toEqual({ approvalId: id, approvalToken: "a.b.c" });
    expect(extractApprovalCredentials({ name: "create-single-variable-experiment", input: { approvalId: id } })).toEqual({ approvalId: id });
    expect(extractApprovalCredentials({ approvalId: "not-a-uuid" })).toBeNull();
    expect(extractApprovalCredentials({})).toBeNull();
    expect(extractApprovalCredentials(null)).toBeNull();
  });
});
