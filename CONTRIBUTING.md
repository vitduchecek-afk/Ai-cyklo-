# Contributing

1. `pnpm install`, then make sure `pnpm check` (typecheck + lint + tests) passes before and after your change.
2. Domain logic goes into `packages/*` as pure, tested functions; the app only composes them.
3. Validate every boundary with zod; throw `TrailPackError` with a specific code.
4. Unit tests must not use the network – record a trimmed real response into `test/fixtures/` and inject `fetch`.
5. User-facing strings: Czech first, add keys to all locale files in `apps/mobile/src/i18n`.
6. Never commit keys, keystores or `.env` files (`node scripts/check-secrets.mjs`).
7. Conventional commit messages (`feat(scope): …`, `fix(scope): …`, `docs: …`).
