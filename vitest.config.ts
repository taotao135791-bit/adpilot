import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts", "evals/**/*.test.ts"],
    testTimeout: 30_000,
    // The suite contains real-process and real-server integration tests that
    // starve each other (and the host) when vitest fans out to every core.
    // Cap workers so the suite stays deterministic even on a busy machine.
    maxWorkers: 4,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/**/src/**/*.ts"]
    }
  },
  resolve: {
    alias: [{ find: /^@adpilot\/(.+)$/, replacement: `${root}packages/$1/src/index.ts` }]
  }
});
