import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts", "evals/**/*.test.ts"],
    testTimeout: 30_000,
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
