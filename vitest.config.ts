import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Some sandboxes have no `localhost` entry; bind and resolve on 127.0.0.1.
  server: { host: '127.0.0.1' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    api: { host: '127.0.0.1' },
    reporters: 'default',
  },
});
