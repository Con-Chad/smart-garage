import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Integration tests run against a real SQLite database. A migrated template
 * database is built once per run (global setup); every test file then works
 * on its own copy, so files can run in parallel without sharing state.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.int.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    globalSetup: ["./test/integration/global-setup.ts"],
    setupFiles: ["./test/integration/setup-db.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
