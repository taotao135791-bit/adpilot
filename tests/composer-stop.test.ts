import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "../apps/desktop/src/components/Composer.js";
import { getCopy } from "../apps/desktop/src/labels.js";

const baseProps = {
  copy: getCopy("en"),
  locale: "en" as const,
  goal: "",
  onGoalChange: vi.fn(),
  chatConfigured: true,
  onSubmit: vi.fn(),
  onConfigureModel: vi.fn(),
  clients: [],
  clientId: "client-a",
  onSelectClient: vi.fn(),
  onModelSaved: vi.fn(),
  onOpenModelSettings: vi.fn()
};

describe("Composer active-run control", () => {
  it("replaces the disabled send action with an enabled Stop run action", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, { ...baseProps, submitting: true, onStop: vi.fn() })
    );
    expect(markup).toContain('<span class="btn-text">Stop run</span>');
    expect(markup).not.toContain('disabled=""><span class="btn-glyph"');
  });

  it("locks the Stop action while the abort request is in flight", () => {
    const markup = renderToStaticMarkup(
      createElement(Composer, { ...baseProps, submitting: true, stopping: true, onStop: vi.fn() })
    );
    expect(markup).toContain('<span class="btn-text">Stopping</span>');
    expect(markup).toContain('disabled=""');
  });
});
