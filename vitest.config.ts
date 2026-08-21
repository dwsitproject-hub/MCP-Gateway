import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // Populates a valid env before any module imports src/core/config.ts.
    setupFiles: ['test/setup.ts'],
    // TSD Section 13: normalizer and guard carry the highest coverage bar.
    coverage: {
      provider: 'v8',
      include: ['src/adapters/klip/normalize.ts', 'src/adapters/klip/client.ts', 'src/mcp/envelope.ts'],
      thresholds: { lines: 95, functions: 95, branches: 90, statements: 95 },
    },
  },
});
