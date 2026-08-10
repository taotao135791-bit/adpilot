import { describe, expect, it } from "vitest";
import {
  initialProjectRightPanelState,
  openProjectRightTab,
  selectProjectRightTab,
  shouldMountProjectTerminal,
  toggleProjectRightPanel
} from "./ProjectView.js";

describe("ProjectView right panel", () => {
  it("starts narrow projects collapsed and wide projects on preview without mounting a shell", () => {
    const narrow = initialProjectRightPanelState(true);
    const wide = initialProjectRightPanelState(false);

    expect(narrow).toEqual({ open: false, tab: "preview", terminalActivated: false });
    expect(wide).toEqual({ open: true, tab: "preview", terminalActivated: false });
    expect(shouldMountProjectTerminal(narrow)).toBe(false);
    expect(shouldMountProjectTerminal(wide)).toBe(false);
  });

  it("mounts a terminal only after an explicit terminal-tab selection", () => {
    const open = toggleProjectRightPanel(initialProjectRightPanelState(true));
    const git = selectProjectRightTab(open, "git");
    const terminal = selectProjectRightTab(git, "terminal");
    const preview = selectProjectRightTab(terminal, "preview");

    expect(shouldMountProjectTerminal(open)).toBe(false);
    expect(shouldMountProjectTerminal(git)).toBe(false);
    expect(shouldMountProjectTerminal(terminal)).toBe(true);
    // Preserve an explicitly started session while another right-panel tab
    // is visible; collapsing the panel is the explicit stop boundary.
    expect(shouldMountProjectTerminal(preview)).toBe(true);
  });

  it("unmounts and forgets terminal activation when the panel closes", () => {
    const active = selectProjectRightTab(initialProjectRightPanelState(false), "terminal");
    const closed = toggleProjectRightPanel(active);
    const reopened = toggleProjectRightPanel(closed);

    expect(closed).toEqual({ open: false, tab: "preview", terminalActivated: false });
    expect(shouldMountProjectTerminal(closed)).toBe(false);
    expect(reopened).toEqual({ open: true, tab: "preview", terminalActivated: false });
    expect(shouldMountProjectTerminal(reopened)).toBe(false);
  });

  it("opens artifact previews without implicitly activating a terminal", () => {
    const preview = openProjectRightTab(initialProjectRightPanelState(true), "preview");

    expect(preview).toEqual({ open: true, tab: "preview", terminalActivated: false });
    expect(shouldMountProjectTerminal(preview)).toBe(false);
  });
});
