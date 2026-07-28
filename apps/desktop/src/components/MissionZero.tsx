import { getCopy, starterCards, type AppLocale } from "../labels.js";
import { IconArrowUpRight, IconBolt, IconLedger, IconShieldCheck, IconTarget } from "../icons.js";

const starterIcons = [IconTarget, IconShieldCheck, IconBolt, IconLedger];

/**
 * Empty state: a left-aligned briefing block over quiet suggestion rows.
 * Picking a row submits its directive immediately — nothing is staged in
 * the composer. The ambient glow lives on .empty-stage, not on the cards.
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
        <span className="mission-kicker">AdPilot</span>
        <h1>{copy.emptyTitle}</h1>
        <p>{copy.heroBody}</p>
      </div>
      <div className="starter-list">
        {starterCards(locale).map((card, index) => {
          const Glyph = starterIcons[index % starterIcons.length]!;
          return (
            <button key={card.title} className="starter-row" onClick={() => onPick(card.prompt)}>
              <span className="starter-glyph" aria-hidden="true"><Glyph size={15} /></span>
              <span className="starter-text">
                <strong>{card.title}</strong>
                <small>{card.prompt}</small>
              </span>
              <IconArrowUpRight size={14} className="starter-arrow" aria-hidden="true" />
            </button>
          );
        })}
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
      <i data-ready={ready} aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
