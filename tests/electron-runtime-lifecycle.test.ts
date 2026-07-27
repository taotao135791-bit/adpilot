import { describe, expect, it, vi } from "vitest";
import { DesktopRuntimeLifecycle } from "../apps/electron/src/runtime-lifecycle.js";

describe("Electron desktop runtime lifecycle", () => {
  it("coalesces concurrent starts and reuses one runtime across window recreation", async () => {
    const lifecycle = new DesktopRuntimeLifecycle<{ id: number }>();
    const start = vi.fn(async () => ({ server: { id: 1 }, url: "http://127.0.0.1:4317" }));

    const [first, concurrent] = await Promise.all([lifecycle.ensure(start), lifecycle.ensure(start)]);
    const afterWindowClose = await lifecycle.ensure(start);

    expect(start).toHaveBeenCalledTimes(1);
    expect(first.server).toBe(concurrent.server);
    expect(afterWindowClose.server).toBe(first.server);
    expect(lifecycle.current()).toEqual(first);
  });

  it("closes the single runtime once and permits a clean process-level restart", async () => {
    const lifecycle = new DesktopRuntimeLifecycle<{ id: number }>();
    const start = vi.fn()
      .mockResolvedValueOnce({ server: { id: 1 }, url: "http://127.0.0.1:4317" })
      .mockResolvedValueOnce({ server: { id: 2 }, url: "http://127.0.0.1:4318" });
    const close = vi.fn(async () => undefined);

    await lifecycle.ensure(start);
    await lifecycle.close(close);
    const restarted = await lifecycle.ensure(start);

    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith({ id: 1 });
    expect(restarted.server.id).toBe(2);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
