import { AuditLog } from "@adpilot/audit";
import type { ApprovalService } from "@adpilot/approvals";
import type { ToolContext } from "@adpilot/tools";
import { classifyToolCall, extractApprovalCredentials, stableJson, type ToolGateRule } from "@adpilot/shared";
import type { PlanModeProbe } from "./plan-mode.js";
import type { AutonomyProbe } from "./autonomy-mode.js";

/**
 * Deterministic write-operation gate enforced in Agent.beforeToolCall.
 *
 * Every model-initiated tool call is classified through TOOL_GATE_RULES
 * (single source of truth in @adpilot/shared). Read calls flow untouched.
 * Write and destructive calls must prove the authority declared by their rule;
 * anything else is blocked before the tool body runs and the denial is chained
 * into the tamper-evident audit log. This removes the previous reliance on each
 * tool policing itself (architecture invariant: model output never bypasses the
 * deterministic guardrails).
 *
 * Plan mode is the one session-level override: while it is enabled for the
 * conversation, every non-read classification is denied outright (the
 * read-only tool shrink is the primary mechanism; this is the deterministic
 * backstop for anything that still reached the model's tool list).
 *
 * Autonomy mode is the client-level counterweight: in `full_access` the gate
 * waives the executed-approval reference for the general local write surface
 * (write/edit and write-classified bash). Destructive classifications — deny
 * bash verdicts, account-mutation dispatches, commit_approved_action — are
 * never waived, in any mode.
 */
/** General local tools whose write-level calls full access lifts from the approval chain. */
const FULL_ACCESS_WAIVED_TOOLS: ReadonlySet<string> = new Set(["write", "edit", "bash", "computer.close_window"]);

export class ToolPermissionGate {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly audit: AuditLog,
    private readonly planMode?: PlanModeProbe,
    private readonly autonomy?: AutonomyProbe
  ) {}

  /**
   * Returns a model-safe denial reason when the call must be blocked, or null
   * when it may proceed. Allowed write/destructive decisions and every denial
   * are appended to the audit hash chain.
   */
  async check(toolName: string, args: unknown, context: ToolContext & { conversationId?: string }): Promise<string | null> {
    const { rule, class: classification, defaulted } = classifyToolCall(toolName, args);
    if (classification === "read") return null;
    const planModeOn = this.planMode && typeof context.conversationId === "string"
      ? await this.planMode.isEnabled(context.clientId, context.conversationId).catch(() => false)
      : false;
    // Full access lifts only the write-level approval reference of the general
    // local tools; destructive classifications (deny bash verdicts, account
    // mutations) and every non-general tool keep their declared authority.
    const fullAccessWaiver = !planModeOn && classification === "write" && FULL_ACCESS_WAIVED_TOOLS.has(toolName)
      && this.autonomy !== undefined
      ? await this.autonomy.mode(context.clientId).then((mode) => mode === "full_access").catch(() => false)
      : false;
    const denial = planModeOn
      ? `Plan mode is active for this conversation: ${toolName} is a ${classification} operation and only read-only tools are available. Present the numbered plan and ask the user to disable plan mode to execute it.`
      : fullAccessWaiver
        ? null
        : await this.authorize(rule, toolName, args, context);
    await this.audit.append({
      clientId: context.clientId,
      taskId: context.taskId,
      actor: context.actor,
      action: "tool_gate",
      status: denial ? "denied" : "succeeded",
      details: {
        tool: toolName,
        classification,
        authority: rule.authority,
        defaulted,
        ...(planModeOn ? { planMode: true } : {}),
        ...(fullAccessWaiver ? { autonomy: "full_access", approvalReferenceWaived: true } : {}),
        ...(denial ? { reason: denial } : { referenceStatuses: rule.referenceStatuses ?? [] })
      }
    });
    return denial;
  }

  private async authorize(rule: ToolGateRule, toolName: string, args: unknown, context: ToolContext): Promise<string | null> {
    if (rule.authority === "self_gated") return null;
    const credentials = extractApprovalCredentials(args);
    if (!credentials) {
      const autonomyHint = rule.authority === "approval_reference" && FULL_ACCESS_WAIVED_TOOLS.has(toolName)
        ? " If the user asked for a routine local action, tell them this workspace is in guarded mode and they can grant full access (Settings or PUT /api/clients/:id/autonomy) to let local write operations run without an approval reference."
        : "";
      return `${toolName} is a ${rule.authority === "approval_token" ? "token-gated" : "approval-gated"} operation and the call carried no approvalId. Prepare an approval and reference it explicitly.${autonomyHint}`;
    }
    const approval = await this.approvals.get(context.clientId, credentials.approvalId).catch(() => undefined);
    if (!approval) return `${toolName} referenced an approval that does not exist`;
    if (approval.clientId !== context.clientId || approval.taskId !== context.taskId) {
      return `${toolName} referenced an approval that belongs to a different client or task`;
    }
    if (rule.authority === "approval_reference") {
      const allowed = rule.referenceStatuses ?? [];
      if (!allowed.includes(approval.status)) {
        return `${toolName} requires an approval in status ${allowed.join(" or ")}; the referenced approval is ${approval.status}`;
      }
      return null;
    }
    return this.authorizeToken(toolName, approval, credentials.approvalToken);
  }

  /**
   * Mirrors the non-destructive checks of ApprovalService.consume: approved
   * status, single-use attempt budget, exact token-binding equality and token
   * expiry. The HMAC signature and nonce hash are still verified inside
   * ApprovalService.consume at execution time, which remains the final
   * authority; the gate only stops calls that could never succeed.
   */
  private authorizeToken(
    toolName: string,
    approval: { status: string; tokenBinding: { expiresAt: string; maxAttempts: number } | null; tokenAttempts: number; tokenExpiresAt: string | null },
    token: string | undefined
  ): string | null {
    if (approval.status !== "approved") return `${toolName} requires an approved approval; the referenced approval is ${approval.status}`;
    if (!token) return `${toolName} requires the approvalToken minted at user approval; tokens are held by the operator, never invented`;
    if (!approval.tokenBinding || approval.tokenAttempts >= approval.tokenBinding.maxAttempts) {
      return `${toolName} referenced an approval whose token attempt budget is exhausted`;
    }
    const parts = token.split(".");
    if (parts.length !== 3) return `${toolName} received a malformed approval token`;
    const [encodedBinding] = parts as [string, string, string];
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encodedBinding, "base64url").toString("utf8"));
    } catch {
      return `${toolName} received a malformed approval token binding`;
    }
    if (stableJson(decoded) !== stableJson(approval.tokenBinding)) {
      return `${toolName} token binding does not match the stored approval binding`;
    }
    const now = Date.now();
    if (!approval.tokenExpiresAt || now >= Date.parse(approval.tokenExpiresAt) || now >= Date.parse(approval.tokenBinding.expiresAt)) {
      return `${toolName} referenced an expired approval token`;
    }
    return null;
  }
}
