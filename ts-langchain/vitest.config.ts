import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/test_*.ts", "tests/**/*.test.ts"],
    setupFiles: ["./tests/vitest.setup.ts"],
    coverage: {
      reporter: ["text", "json"],
    },
  },
  // Use tsconfig.tests.json for type checking (includes tests/ + src/)
  tsconfig: "./tsconfig.tests.json",
});
