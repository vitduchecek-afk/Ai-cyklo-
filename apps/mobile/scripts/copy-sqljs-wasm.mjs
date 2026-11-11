// Copies the sql.js WebAssembly binary into public/ so the web build can
// serve it from the same origin (used by the web SQLite driver).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
try {
  const src = join(dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
  const outDir = join(here, '..', 'public');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  copyFileSync(src, join(outDir, 'sql-wasm.wasm'));
  console.log('[trailpack] copied sql-wasm.wasm to public/');
} catch (e) {
  console.warn('[trailpack] could not copy sql-wasm.wasm:', e.message);
}
