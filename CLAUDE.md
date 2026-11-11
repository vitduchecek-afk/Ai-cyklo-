# CLAUDE.md – pokyny pro další vývoj TrailPack

Read [docs/STATUS.md](docs/STATUS.md) first: it lists what is done and the next steps in order.

## Layout

- `packages/shared` – zod models (single source of truth), `TrailPackError`, `HttpClient`, cache, units, provider catalogue.
- `packages/{calculations,gear,nutrition,formats,routing,maps,weather,regulations}` – pure domain logic + provider adapters.
- `packages/database` (SQL driver abstraction, migrations, repositories; `@trailpack/database/node` = node:sqlite driver,
  never import it from the app), `packages/sync`.
- `packages/ai` – `providers/` (raw-fetch transports), `agent/` (loop, prompt, security), `tools/` (23 tools over
  `ToolPorts`), `planner/` (expedition planner, rule-based parser), `recommendations/`.
- `apps/api` – Hono backend (AI proxy, sync, sharing). `apps/mobile` – Expo app (routes in `src/app`).

## Commands

```bash
pnpm test                         # vitest (unit project); TRAILPACK_LIVE_TESTS=1 pnpm test:live for live API tests
pnpm typecheck && pnpm lint       # must be clean (lint uses --max-warnings=0)
pnpm build:web                    # expo export → apps/mobile/dist
pnpm e2e                          # Playwright against the web build
```

## Rules

- Deterministic numbers (weights, distances, times, water, energy, power, money) come from code, never from the LLM.
- Facts come from real providers; every external datum keeps `source` + retrieval time. Estimates carry `estimated`/`confidence`.
- Legal status of overnight stays: only `verified_allowed | conditional | prohibited | unverified`; never upgrade unknown to allowed.
  The regulations dataset is unreviewed – do not present it as legal advice.
- Never present weather beyond the forecast horizon (16 days) as a forecast.
- No secrets in code or git. Keys: SecureStore (device) or env vars (server).
- New external service = new adapter behind the existing interface + entry in `packages/shared/src/config.ts`.
- Domain packages must stay platform-neutral (no `node:` imports in app-facing entry points, no RN imports).
- AI layer talks to the app only through `ToolPorts`; mutating tools require user confirmation.
- Tests: no network in unit tests (inject `fetch` into `HttpClient`); recorded real fixtures live in `packages/*/test/fixtures`.

## Known environment quirks (cloud sessions)

- A Semgrep Guardian hook may block package installs and the Edit tool when not logged in.
- Maven Central can rate-limit (HTTP 429) behind the shared egress; Gradle needs JDK 17 for the RN gradle plugin.
