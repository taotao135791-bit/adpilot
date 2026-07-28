import { describe, expect, it } from "vitest";
import { overlayGeometry } from "./components/ComputerUseCard.js";

describe("Computer Live View overlay coordinates", () => {
  it("projects screenshot pixels into stable viewport percentages", () => {
    expect(overlayGeometry({
      coordinateSpace: "screenshot_pixels",
      targetBox: { x: 500, y: 250, width: 250, height: 125 },
      pointer: { x: 625, y: 312.5 }
    }, {
      width: 1_000,
      height: 500,
      capturedAt: "2026-07-28T00:00:00.000Z",
      sha256: "a".repeat(64)
    })).toEqual({
      targetBox: { left: "50%", top: "50%", width: "25%", height: "25%" },
      pointer: { left: "62.5%", top: "62.5%" }
    });
  });

  it("clamps out-of-range model geometry to the visible viewport", () => {
    expect(overlayGeometry({
      coordinateSpace: "screenshot_pixels",
      pointer: { x: 2_000, y: 900 }
    }, {
      width: 1_000,
      height: 500,
      capturedAt: "2026-07-28T00:00:00.000Z",
      sha256: "b".repeat(64)
    })?.pointer).toEqual({ left: "100%", top: "100%" });
  });
});
