# TrailPack

**Your intelligent outdoor companion** – offline‑first aplikace pro plánování turistiky, bivakování, kempování,
ultralehkých výprav a bikepackingu (Android, iOS, web).

> **Stav:** vývojová verze. Doménová logika, backend a UI kit jsou hotové a otestované (640 testů);
> obrazovky aplikace se teprve napojují na data. Pravdivý přehled je v [docs/STATUS.md](docs/STATUS.md).

## Funkce (doménová vrstva)

- Plánování tras přes BRouter / Valhalla (zdarma) nebo openrouteservice / GraphHopper / Mapy.com (klíč),
  výškový profil, převýšení, čas chůze (DIN 33466) a jízdy, rozdělení na etapy ukotvené na legální nocoviště.
- Počasí Open‑Meteo podél trasy podle času průchodu, rizika (bouřky, vítr, mráz…), doporučení výbavy.
- Pravidla nocování a ohně (CZ, SK, PL, AT, DE, CH) se zdrojem a stavem ověření; vodní zdroje a nocoviště z OSM.
- Výbava: base/worn/consumable hmotnost, UL optimalizátor s bezpečnostními omezeními, asistent balení, checklisty,
  import CSV (vč. LighterPack) / JSON.
- Voda, jídelníček, energie, palivo, elektronika ve Wh, rozpočet a vyrovnání ve skupině, statistiky, GPS záznam.
- AI: Anthropic, OpenAI, Gemini, lokální OpenAI‑kompatibilní modely; agent s 23 nástroji, potvrzováním změn
  a ochranou proti prompt injection; plánovač celé expedice z českého textu (funguje i offline bez LLM).
- Offline‑first SQLite, synchronizace, sdílení výprav ve skupině, GPX/KML/GeoJSON, PDF report.

## Technologie

Expo SDK 58 · React Native 0.88 · expo-router · TypeScript strict · MapLibre · SQLite (expo-sqlite / sql.js) ·
Zustand · TanStack Query · zod · Hono (Node 22) · PostgreSQL/SQLite · Vitest · Playwright · GitHub Actions.
Architektura: [ARCHITECTURE.md](ARCHITECTURE.md).

## Požadavky

- Node.js ≥ 22.13, pnpm 10 (`corepack enable`)
- Android: JDK 17 (Gradle plugin RN) i JDK 21, Android SDK (platforma 37, build‑tools 37, NDK 27.1, CMake 3.22)
- iOS: macOS + Xcode (nebo EAS Build)

## Instalace a spuštění (Windows 11 / macOS / Linux)

```bash
pnpm install
pnpm test            # unit + integrační testy
pnpm typecheck
pnpm dev:web         # webová aplikace (Expo)
pnpm dev:api         # backend na http://localhost:8787
```

Android (vývojový build na zařízení/emulátoru):

```bash
cd apps/mobile
npx expo prebuild --platform android
npx expo run:android            # Windows: spusťte v PowerShellu s nastaveným ANDROID_HOME
```

Release APK/AAB: `cd apps/mobile/android && ./gradlew assembleRelease bundleRelease`
(Windows: `gradlew.bat`). Podepisování upload klíčem přes proměnné `TRAILPACK_UPLOAD_STORE_FILE`,
`TRAILPACK_UPLOAD_STORE_PASSWORD`, `TRAILPACK_UPLOAD_KEY_ALIAS`, `TRAILPACK_UPLOAD_KEY_PASSWORD`
(viz `apps/mobile/plugins/withReleaseSigning.js`); bez nich se použije debug klíč (jen pro testování).
V CI to dělá workflow `.github/workflows/ci.yml` (artefakt `trailpack-android`).

Web build: `pnpm build:web` → `apps/mobile/dist` (statický SPA; náhled `node scripts/serve-static.mjs`).

## Konfigurace API

Výchozí konfigurace funguje bez placených klíčů (OpenFreeMap, BRouter, Valhalla, Photon, Nominatim, Overpass,
Open‑Meteo). Volitelné klíče: Mapy.com, openrouteservice, GraphHopper, OpenAI, Anthropic, Gemini.
Klíče se nikdy necommitují: v aplikaci se ukládají do SecureStore, na serveru do proměnných prostředí
(`apps/api/.env.example`). Přehled služeb a limitů: `packages/shared/src/config.ts` a [docs/STATUS.md](docs/STATUS.md).

## Licenční omezení

Mapová data © OpenStreetMap contributors (ODbL) – atribuce je povinná. Open‑Meteo je zdarma jen pro nekomerční
použití. Veřejné servery (Nominatim, Overpass, BRouter, Valhalla) mají fair‑use pravidla, která aplikace dodržuje
(throttling, cache, žádný autocomplete přes Nominatim). Offline balíčky jen ze stylů, které to povolují.

## Bezpečnost

Žádné tajné klíče v repozitáři (`node scripts/check-secrets.mjs`), hashované tokeny na serveru, rate limiting,
limity velikosti importů, XXE‑bezpečný XML parser, potvrzování AI změn dat, GDPR export a smazání.

## Řešení problémů

- `pnpm install` selže na nativních modulech → Node 22 LTS a čistý `node_modules`.
- Gradle: „Cannot find Java 17“ → nainstalujte JDK 17 (plugin React Native vyžaduje toolchain 17).
- Mapa na webu bez dlaždic → zkontrolujte síť / CSP; dlaždice OpenFreeMap vyžadují internet nebo offline balíček.
