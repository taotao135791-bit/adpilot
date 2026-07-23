import { approvalDisclosure, type Approval } from "../approvalDisclosure.js";
import {
  approvalStatusLabel,
  approvalStatusTone,
  operationLabel,
  type AppLocale,
  type ConsoleCopy
} from "../labels.js";
import { Badge, Button } from "../ui.js";
import { IconShieldCheck } from "../icons.js";
import { Empty } from "./AgentRail.js";

/** Approval-gate panel: the queue of approval requests plus its empty state. */
export function ApprovalQueue({ approvals, copy, locale, onRiskReview, onApprove, onCommit }: {
  approvals: Approval[];
  copy: ConsoleCopy;
  locale: AppLocale;
  onRiskReview: (approval: Approval) => void;
  onApprove: (approval: Approval) => void;
  onCommit: (approval: Approval) => void;
}) {
  return (
    <section className="queue-panel panel" aria-label={copy.approvalGate}>
      <header className="panel-heading">
        <div className="panel-title"><IconShieldCheck size={15} /><h2>{copy.approvalGate}</h2></div>
        <span className="panel-count">{approvals.length}</span>
      </header>
      {approvals.length
        ? approvals.slice().reverse().map((approval) => (
            <ApprovalCard
              approval={approval}
              locale={locale}
              copy={copy}
              onRiskReview={onRiskReview}
              onApprove={onApprove}
              onCommit={onCommit}
              key={approval.id}
            />
          ))
        : <Empty title={copy.gateClear} body={copy.gateClearBody} />}
    </section>
  );
}

/**
 * One approval request in the gate. The four disclosure sections stay fully
 * expanded (current IA) but are visually layered: human-readable operation
 * basis reads at body size, while engineering identifiers and fingerprints
 * are demoted to truncated mono microcopy with the full value on hover.
 */
export function ApprovalCard({ approval, locale, copy, onRiskReview, onApprove, onCommit }: {
  approval: Approval;
  locale: AppLocale;
  copy: ConsoleCopy;
  onRiskReview: (approval: Approval) => void;
  onApprove: (approval: Approval) => void;
  onCommit: (approval: Approval) => void;
}) {
  const sections = approvalDisclosure(approval, locale);
  return (
    <article className="approval-item">
      <header className="approval-head">
        <strong>{operationLabel(approval.operation.operation, locale)}</strong>
        <Badge tone={approvalStatusTone(approval.status)} variant="soft">{approvalStatusLabel(approval.status, locale)}</Badge>
      </header>
      <p className="approval-campaign">{approval.operation.campaign}</p>
      <dl className="approval-delta">
        <div>
          <dt>{copy.current}</dt>
          <dd>{String(approval.operation.currentValue)}</dd>
        </div>
        <span className="delta-arrow" aria-hidden="true">→</span>
        <div>
          <dt>{copy.proposed}</dt>
          <dd>{String(approval.operation.proposedValue)}</dd>
        </div>
      </dl>
      <div className="approval-disclosure" aria-label={copy.approvalDisclosure}>
        {sections.map((section) => (
          <section className="approval-disclosure-section" key={section.title}>
            <h3>{section.title}</h3>
            <dl>
              {section.entries.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd
                    className={item.mono ? "approval-mono" : undefined}
                    title={item.fullValue}
                    aria-label={item.fullValue ? `${item.label}: ${item.fullValue}` : undefined}
                  >
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <div className="approval-actions">
        {approval.status === "pending_risk_review" && <Button size="sm" variant="outline" onClick={() => onRiskReview(approval)}>{copy.runRisk}</Button>}
        {approval.status === "pending_user" && <Button size="sm" variant="primary" onClick={() => onApprove(approval)}>{copy.approveOnce}</Button>}
        {approval.status === "approved" && (
          <Button size="sm" variant="primary" disabled={!approval.executionPlan} onClick={() => onCommit(approval)}>
            {approval.executionPlan ? copy.executeApproved : copy.missingPlan}
          </Button>
        )}
      </div>
    </article>
  );
}
