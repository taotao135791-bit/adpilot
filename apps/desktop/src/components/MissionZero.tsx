import { getCopy, starterGoals, type AppLocale } from "../labels.js";
import { IconArrowUpRight } from "../icons.js";

/**
 * Empty state for a workspace with no active mission and no messages yet.
 * Keeps the onboarding value (what AdPilot does, three starter goals,
 * readiness at a glance) with one headline and zero decorative motion.
 */
export function MissionZero({ onPick, guiReady, clients, locale }: {
  onPick: (goal: string) => void;
  guiReady: boolean;
  clients: number;
  locale: AppLocale;
}) {
  const copy = getCopy(locale);
  return (
    <section className="mission-zero">
      <div className="mission-copy">
        <span className="section-kicker">{copy.heroKicker}</span>
        <h1>{copy.heroLine1}<br /><em>{copy.heroLine2}</em><br />{copy.heroLine3}</h1>
        <p>{copy.heroBody}</p>
      </div>
      <div className="starter-list">
        {starterGoals(locale).map((item: string, index: number) => (
          <button key={item} className="starter-item" onClick={() => onPick(item)}>
            <span className="starter-index" aria-hidden="true">0{index + 1}</span>
            <span className="starter-text">{item}</span>
            <IconArrowUpRight size={14} className="starter-arrow" />
          </button>
        ))}
      </div>
      <div className="readiness-strip">
        <Readiness label={copy.workspaceReady} value={clients ? copy.connected : copy.required} ready={clients > 0} />
        <Readiness label={copy.vision} value={guiReady ? copy.ready : copy.offline} ready={guiReady} />
        <Readiness label={copy.safetyGate} value={copy.enforced} ready />
      </div>
    </section>
  );
}

function Readiness({ label, value, ready }: { label: string; value: string; ready: boolean }) {
  return (
    <div className="readiness">
      <span>{label}</span>
      <strong><i data-ready={ready} aria-hidden="true" />{value}</strong>
    </div>
  );
}
