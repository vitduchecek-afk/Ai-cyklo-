# TrailPack – nasazení webové verze (předávací dokument)

Repozitář: `vitduchecek-afk/Ai-cyklo-`, větev `ccr-3c47a6a3-ba94j6` (poslední ověřený commit `c487363`).

## Co se nasazuje

Statická SPA (Expo web export). Nepotřebuje server ani databázi – data se ukládají v prohlížeči
(SQLite přes sql.js, perzistence do IndexedDB). Backend `apps/api` je **volitelný** (jen AI proxy) a pro web není nutný.

## Build

```bash
corepack enable            # pnpm 10
pnpm install --frozen-lockfile
pnpm build:web             # → apps/mobile/dist  (index.html, _expo/, assets/, sql-wasm.wasm, favicon.ico)
```

Požadavky: Node ≥ 22.13. `sql-wasm.wasm` se do `apps/mobile/public/` kopíruje při `postinstall`
(skript `apps/mobile/scripts/copy-sqljs-wasm.mjs`) a export ho přenese do `dist/`.
Lokální náhled: `node scripts/serve-static.mjs apps/mobile/dist 4173`.

## Požadavky na hosting

1. **SPA fallback** – všechny neznámé cesty (`/trips`, `/trip/<id>`, `/settings`…) musí vracet `index.html`.
   - Netlify: `_redirects` → `/*  /index.html  200`
   - Vercel: `vercel.json` → `{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }`
   - Nginx: `try_files $uri $uri/ /index.html;`
   - Apache: `FallbackResource /index.html`
2. **Nasazení do kořene domény/subdomény** (např. `trailpack.mujweb.cz`). Aplikace načítá
   `/sql-wasm.wasm` a `/_expo/...` absolutní cestou (`apps/mobile/src/data/db.web.ts`). Pro podadresář
   (`mujweb.cz/trailpack/`) je nutné nastavit `experiments.baseUrl` v `apps/mobile/app.json` a upravit
   cestu k wasm na `${baseUrl}/sql-wasm.wasm`.
3. **MIME typ** `application/wasm` pro `.wasm` (většina hostingů má výchozí).
4. **HTTPS** – nutné pro geolokaci a kopírování do schránky.
5. Pokud web posílá **Content-Security-Policy**, povolte:
   - `connect-src`: `https://tiles.openfreemap.org https://photon.komoot.io https://nominatim.openstreetmap.org https://brouter.de https://valhalla1.openstreetmap.de https://api.open-meteo.com https://overpass-api.de` (+ `https://api.anthropic.com https://api.openai.com https://generativelanguage.googleapis.com` pro AI chat)
   - `img-src`: `https: data: blob:` · `worker-src blob:` (MapLibre) · `script-src 'self' 'wasm-unsafe-eval'` (sql.js)
6. Cache: `_expo/static/*` lze cachovat dlouhodobě (hash v názvu), `index.html` bez cache.

## Ověřeno před předáním

- `pnpm test` 645/645, typecheck všech workspace čistý, ESLint čistý.
- Web build: všechny obrazovky (Domů, Mapa, Výpravy, Výbava, AI, Nastavení) se vykreslí bez chyb, mapa načítá
  dlaždice OpenFreeMap, přidaná výbava přežije obnovení stránky.
- Neověřeno: celý tok „nová výprava“ (vyhledání míst → BRouter → etapy) automatickým testem.

## Známá omezení webu

- Nastavení (téma, jazyk, AI poskytovatel) se neukládají mezi návštěvami; API klíč na webu jen v paměti.
- AI chat volá poskytovatele přímo z prohlížeče s klíčem uživatele (Anthropic s hlavičkou pro přímý přístup;
  OpenAI/Gemini mohou blokovat CORS → pak je nutný backend `apps/api` jako proxy).
- Veřejné služby (BRouter, Photon, Nominatim, Overpass) mají fair‑use limity; Open‑Meteo je zdarma jen nekomerčně.
- Mapová atribuce OpenStreetMap/OpenFreeMap musí zůstat viditelná.
- Kompletní stav funkcí: [docs/STATUS.md](STATUS.md).

## Volitelně: backend (AI proxy)

`apps/api` – viz [apps/api/README.md](../apps/api/README.md) (Node 22 nebo Docker, klíče v env proměnných).

## Prompt pro nový chat

> Nasaď webovou verzi aplikace TrailPack z repozitáře `vitduchecek-afk/Ai-cyklo-` (větev `ccr-3c47a6a3-ba94j6`)
> na můj web <DOMÉNA / HOSTING>. Postup a požadavky jsou v `docs/DEPLOY.md`: build `pnpm install && pnpm build:web`,
> výstup `apps/mobile/dist`, nutný SPA fallback na `index.html`, nasazení do kořene (sub)domény, MIME `application/wasm`,
> HTTPS. Po nasazení ověř, že se načte mapa a že přidaná výbava zůstane po obnovení stránky.
