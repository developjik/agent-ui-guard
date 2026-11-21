import { expect, test as base } from '@playwright/test';
import { startDemoServer, type DemoMode, type DemoServer } from '../demo/server.js';

export type DemoFixture = (mode: DemoMode) => Promise<string>;

/**
 * Starts one demo server per requested mode and shuts them down when the test
 * ends. An empty transcript is enough; each test asks for the mode it needs.
 */
export const test = base.extend<{ demo: DemoFixture }>({
  demo: async ({}, use) => {
    const servers: DemoServer[] = [];
    await use(async (mode: DemoMode) => {
      const server = await startDemoServer({ mode });
      servers.push(server);
      return server.url;
    });
    for (const server of servers) await server.close();
  },
});

export { expect };
