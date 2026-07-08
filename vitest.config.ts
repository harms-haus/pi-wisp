import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for pi-wisp.
 *
 * Coverage thresholds are set to a defensible level the suite ACTUALLY meets.
 * The executor (loop.ts, resume.ts) and tool layer (run-workflow.ts) contain
 * subprocess-error / resume / abort paths that are exercised by integration
 * tests (E2E) but are impractical to cover fully via unit tests — those paths
 * involve real tsx subprocess execution, real pi CLIs, and complex error
 * classification (S16/S33/S39). Rather than chasing diminishing returns through
 * fragile mocks, we set branches at 70% and lines/statements at 85% — a level
 * every commit can sustain. See PLAN.md S39 for the E2E coverage strategy.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    clearMocks: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/__tests__/**",
        "src/**/*.test.ts",
        "src/**/setup.ts",
        "src/**/helpers/**",
        "src/**/*.d.ts",
        "src/types.ts",
        "src/types/**",
        // Untestable standalone tsx subprocess entrypoint (0% coverage
        // because it's never loaded by any test — it's spawned by node
        // --import tsx as a child process). See S15 / compile-harness.ts.
        "src/dsl/compile-harness.ts",
      ],
      thresholds: {
        statements: 85,
        branches: 70,
        functions: 90,
        lines: 85,
      },
    },
  },
});
