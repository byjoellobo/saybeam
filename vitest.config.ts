import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/web/test/**/*.test.ts', 'apps/worker/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/protocol/src/**/*.ts', 'apps/web/src/lib/**/*.ts', 'apps/web/src/engines/segmenter.ts', 'apps/web/src/engines/whisperlive-protocol.ts'],
      reporter: ['text', 'html'],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 75 },
    },
  },
});
