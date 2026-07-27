export interface StartedDesktopRuntime<Server> {
  server: Server;
  url: string;
}

/**
 * Owns exactly one local Runtime/Server for the lifetime of the Electron
 * process. Closing the last macOS window does not close this controller, so a
 * later Dock activation recreates only the window and reuses the same state
 * authority.
 */
export class DesktopRuntimeLifecycle<Server> {
  #server: Server | undefined;
  #url: string | undefined;
  #starting: Promise<StartedDesktopRuntime<Server>> | undefined;

  async ensure(start: () => Promise<StartedDesktopRuntime<Server>>): Promise<StartedDesktopRuntime<Server>> {
    if (this.#server && this.#url) return { server: this.#server, url: this.#url };
    if (!this.#starting) {
      this.#starting = start().then((runtime) => {
        if (!runtime.url || !runtime.server) throw new Error("desktop runtime did not return a server and URL");
        this.#server = runtime.server;
        this.#url = runtime.url;
        return runtime;
      }).finally(() => {
        this.#starting = undefined;
      });
    }
    return this.#starting;
  }

  current(): StartedDesktopRuntime<Server> | undefined {
    return this.#server && this.#url ? { server: this.#server, url: this.#url } : undefined;
  }

  async close(close: (server: Server) => Promise<void>): Promise<void> {
    const pending = this.#starting;
    if (pending) await pending;
    const server = this.#server;
    this.#server = undefined;
    this.#url = undefined;
    if (server) await close(server);
  }
}
