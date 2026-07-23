import {
  auditActionLabel,
  experimentStatusLabel,
  formatTime,
  roleLabel,
  variableLabel,
  type AppLocale,
  type ConsoleCopy
} from "../labels.js";
import type { Audit, Experiment, ModelStatus } from "../types.js";
import { Badge } from "../ui.js";
import { IconBot, IconLedger, IconTarget } from "../icons.js";

/**
 * The operations rail below the computer panel: agent network, experiments,
 * and audit trace. Panels are quiet stacked sections separated by hairlines;
 * only genuinely interactive or actionable items get surfaces.
 */
export function AgentRail({ copy, locale, activeAgents, models, taskActive, experiments, audit }: {
  copy: ConsoleCopy;
  locale: AppLocale;
  activeAgents: string[];
  models: ModelStatus;
  taskActive: boolean;
  experiments: Experiment[];
  audit: Audit[];
}) {
  return (
    <>
      <section className="system-panel panel" aria-label={copy.agentNetwork}>
        <header className="panel-heading">
          <div className="panel-title"><IconBot size={15} /><h2>{copy.agentNetwork}</h2></div>
          <span className="panel-count">{activeAgents.length || 1}</span>
        </header>
        <div className="agent-network">
          <strong>{activeAgents.length ? activeAgents.map((role) => roleLabel(role, locale)).join(" · ") : copy.coordinatorReady}</strong>
          <span>{taskActive ? copy.specialistsAttached : copy.waitingDirective}</span>
        </div>
        <div className="model-grid">
          <ModelRow label={copy.fast} value={models.fast} empty={copy.unassigned} unsupported={copy.unsupported} />
          <ModelRow label={copy.deep} value={models.strong} empty={copy.unassigned} unsupported={copy.unsupported} />
          <ModelRow label={copy.vision} value={models.gui} warn={!models.guiConfigured} empty={copy.unassigned} unsupported={copy.unsupported} />
          <ModelRow label={copy.visionPlus} value={models.guiStrong} warn={!models.guiConfigured} empty={copy.unassigned} unsupported={copy.unsupported} />
        </div>
      </section>

      <section className="experiments-panel panel compact-panel" aria-label={copy.experiments}>
        <header className="panel-heading">
          <div className="panel-title"><IconTarget size={15} /><h2>{copy.experiments}</h2></div>
          <span className="panel-count">{experiments.length}</span>
        </header>
        {experiments.length
          ? experiments.slice(0, 3).map((experiment) => (
              <div className="experiment-row" key={experiment.id}>
                <div><strong>{variableLabel(experiment.variable, locale)}</strong><span>{experiment.hypothesis}</span></div>
                <Badge tone="neutral" variant="outline">{experimentStatusLabel(experiment.status, locale)}</Badge>
              </div>
            ))
          : <Empty title={copy.noTests} body={copy.noTestsBody} />}
      </section>

      <section className="audit-panel panel compact-panel" aria-label={copy.auditTrace}>
        <header className="panel-heading">
          <div className="panel-title"><IconLedger size={15} /><h2>{copy.auditTrace}</h2></div>
          <span className="panel-count">{audit.length}</span>
        </header>
        {audit.length
          ? audit.slice(-4).reverse().map((event) => (
              <div className="audit-row" key={event.id}>
                <span>{auditActionLabel(event.action, locale)}</span>
                <time>{formatTime(event.at, locale)}</time>
              </div>
            ))
          : <Empty title={copy.tracePristine} body={copy.traceBody} />}
      </section>
    </>
  );
}

function ModelRow({ label, value, warn = false, empty, unsupported }: {
  label: string;
  value: string;
  warn?: boolean;
  empty: string;
  unsupported: string;
}) {
  const displayValue = !value || value === "not configured" ? empty : value === "not supported" ? unsupported : value;
  const emptyValue = displayValue === empty || displayValue === unsupported;
  return (
    <div className="model-row">
      <span>{label}</span>
      <strong className={warn ? "warn" : emptyValue ? "empty" : ""} title={displayValue}>{displayValue}</strong>
    </div>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}
