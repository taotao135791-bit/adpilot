import {
  auditActionLabel,
  experimentStatusLabel,
  formatTime,
  variableLabel,
  type AppLocale,
  type ConsoleCopy
} from "../labels.js";
import type { Audit, Experiment } from "../types.js";
import { Badge } from "../ui.js";
import { IconLedger, IconTarget } from "../icons.js";

/**
 * On-demand insight cards, answered locally from /api/state data when the
 * operator types /experiments or /audit-trail. They mirror the server's
 * direct-answer pattern (an inline system card in the feed) and render the
 * live state slices, so reopened cards always show current data.
 */
export function ExperimentsCard({ copy, locale, experiments, at }: {
  copy: ConsoleCopy;
  locale: AppLocale;
  experiments: Experiment[];
  at: string;
}) {
  return (
    <article className="insight-card">
      <div className="message-avatar insight-avatar" aria-hidden="true"><IconTarget size={14} /></div>
      <div className="message-main">
        <header className="message-meta">
          <strong>{copy.experiments}</strong>
          <span className="insight-command">{copy.experimentsCommand}</span>
          <time>{formatTime(at, locale)}</time>
        </header>
        {experiments.length
          ? experiments.map((experiment) => (
              <div className="experiment-row" key={experiment.id}>
                <div><strong>{variableLabel(experiment.variable, locale)}</strong><span>{experiment.hypothesis}</span></div>
                <Badge tone="neutral" variant="outline">{experimentStatusLabel(experiment.status, locale)}</Badge>
              </div>
            ))
          : <Empty title={copy.noTests} body={copy.noTestsBody} />}
      </div>
    </article>
  );
}

export function AuditCard({ copy, locale, audit, at }: {
  copy: ConsoleCopy;
  locale: AppLocale;
  audit: Audit[];
  at: string;
}) {
  const shown = audit.slice(-8).reverse();
  return (
    <article className="insight-card">
      <div className="message-avatar insight-avatar" aria-hidden="true"><IconLedger size={14} /></div>
      <div className="message-main">
        <header className="message-meta">
          <strong>{copy.auditTrace}</strong>
          <span className="insight-command">{copy.auditCommand}</span>
          <time>{formatTime(at, locale)}</time>
        </header>
        {audit.length
          ? (
            <>
              {shown.map((event) => (
                <div className="audit-row" key={event.id}>
                  <span>{auditActionLabel(event.action, locale)}</span>
                  <time>{formatTime(event.at, locale)}</time>
                </div>
              ))}
              <small className="insight-total">{copy.recordsTotal.replace("{count}", String(audit.length))}</small>
            </>
          )
          : <Empty title={copy.tracePristine} body={copy.traceBody} />}
      </div>
    </article>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}
