#!/usr/bin/env node
// Minimal static file server with SPA fallback, used by Playwright E2E tests
// and for previewing the exported web app: `node scripts/serve-static.mjs apps/mobile/dist 4173`.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'apps/mobile/dist');
const port = Number(process.argv[3] ?? process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

if (!existsSync(root)) {
  console.error(`[serve-static] directory not found: ${root} (run "pnpm build:web" first)`);
  process.exit(1);
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  const target = normalize(join(root, rel));
  if (!target.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  let file = target;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const html = `${target}.html`;
    if (existsSync(html)) file = html;
    else if (existsSync(join(target, 'index.html'))) file = join(target, 'index.html');
    else file = join(root, 'index.html'); // SPA fallback
  }
  rel = extname(file);
  res.writeHead(200, {
    'Content-Type': TYPES[rel] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(res);
}).listen(port, () => console.info(`[serve-static] http://localhost:${port} → ${root}`));
