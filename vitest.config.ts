import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/server.ts', 'src/cli.ts'],
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
        'src/security/**/*.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'src/adapters/**/*.ts': {
          lines: 90,
          branches: 85,
          functions: 100,
          statements: 90,
        },
        'src/publish-service.ts': {
          lines: 95,
          branches: 90,
          functions: 100,
          statements: 95,
        },
        'src/activation-store.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'src/github-channel.ts': {
          lines: 100,
          branches: 80,
          functions: 100,
          statements: 95,
        },
        'src/local-runtime.ts': {
          lines: 100,
          branches: 100,
          functions: 100,
          statements: 100,
        },
        'src/github-observability.ts': {
          lines: 95,
          branches: 90,
          functions: 100,
          statements: 95,
        },
        'src/receipt-store.ts': {
          lines: 95,
          branches: 90,
          functions: 100,
          statements: 95,
        },
        'src/runtime/gh-process.ts': {
          lines: 95,
          branches: 80,
          functions: 90,
          statements: 90,
        },
      },
    },
  },
});
