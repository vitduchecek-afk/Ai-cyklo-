/** Production entry point: `node dist/server.js` (or `pnpm dev:api`). */
import { serve } from '@hono/node-server';
import { createProviderTransport } from '@trailpack/ai';

import { createApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const app = createApp({ config, transportFactory: (provider, creds) => createProviderTransport(provider, creds) });

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.info(`[trailpack-api] listening on http://${info.address}:${info.port}`);
});
