import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  root: repositoryRoot,
  test: {
    include: ["apps/desktop/src/**/*.test.ts"],
    environment: "node"
  }
});
