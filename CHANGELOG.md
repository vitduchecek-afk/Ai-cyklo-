# Changelog

## [Unreleased] – 2026-11-11

### Added
- Monorepo (pnpm workspaces), strict TypeScript, Vitest, ESLint, GitHub Actions (checks, web + E2E, API, Android APK/AAB, releases, secret scan).
- `@trailpack/shared`: zod models for all entities, error model, HTTP client, cache, units, provider catalogue.
- `@trailpack/calculations`: geodesy, elevation, DIN 33466 / cycling time model, stages, sun, difficulty, schedule, water, energy, power, budget, stats, GPS tracking.
- `@trailpack/gear`, `@trailpack/nutrition`: pack weights, UL optimizer, packing, checklists, import/export, templates, foods, meal planner, fuel.
- `@trailpack/formats`, `@trailpack/routing`, `@trailpack/maps`: GPX/KML/GeoJSON, trip report, routing adapters + service, map styles, tiles, geocoding, OSM POIs.
- `@trailpack/weather`, `@trailpack/regulations`: Open-Meteo, weather along route, risks, gear advice, date comparison; camping rules engine (unreviewed dataset), country detection, emergency numbers.
- `@trailpack/database`, `@trailpack/sync`, `apps/api`: SQLite repositories and backups, sync engine, Hono backend.
- `@trailpack/ai`: provider transports, agent loop, 23 tools, expedition planner, recommendations.
- `apps/mobile`: design system, UI kit, charts, icons, i18n (cs/en/sk/pl/de), navigation shell.

### Not yet done
See [docs/STATUS.md](docs/STATUS.md).
