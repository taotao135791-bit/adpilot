import { getCopy, starterCards, type AppLocale } from "../labels.js";
import { IconArrowUpRight } from "../icons.js";

/**
 * Empty state, Codex-style: one centered headline, a 2×2 grid of
 * suggestion cards, and the readiness strip underneath. Picking a card
 * submits its directive immediately — nothing is staged in the composer.
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
        <h1>{copy.emptyTitle}</h1>
        <p>{copy.heroBody}</p>
      </div>
      <div className="starter-grid">
        {starterCards(locale).map((card) => (
          <button key={card.title} className="starter-card" onClick={() => onPick(card.prompt)}>
            <span className="starter-card-text">{card.title}</span>
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
