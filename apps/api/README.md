# TrailPack API

Volitelný backend: AI proxy (klíče poskytovatelů zůstávají jen na serveru), anonymní registrace zařízení,
limity požadavků a měsíční rozpočet na AI.

```bash
cp .env.example .env     # doplňte klíče (nikdy necommitovat)
pnpm --filter @trailpack/api build && node apps/api/dist/server.js
docker build -f apps/api/Dockerfile -t trailpack-api .   # z kořene repozitáře
```

| Endpoint | Popis |
|---|---|
| `GET /health` | stav serveru |
| `GET /v1/meta` | verze, nakonfigurovaní poskytovatelé AI (jen true/false), povolené modely |
| `POST /v1/auth/device` | → `{userId, token}`; server ukládá jen SHA‑256 hash tokenu |
| `POST /v1/ai/chat` | `Authorization: Bearer <token>`, tělo = `ChatRequest` (`@trailpack/ai`); kontrola povolených modelů a rozpočtu |
| `GET /v1/ai/usage` | využití AI v aktuálním měsíci |

Ochrana: CORS allow‑list, bezpečnostní hlavičky, limity velikosti těla (1 MB / 8 MB pro AI), token‑bucket
rate limiting (IP, uživatel, registrace), chyby bez stack trace a klíčů.

Stav: tokeny a využití se drží v paměti (jedna instance; po restartu se klient znovu zaregistruje).
Endpointy synchronizace a sdílení výprav a perzistentní úložiště (SQLite/PostgreSQL) jsou další krok – viz
[docs/STATUS.md](../../docs/STATUS.md). Klientská část synchronizace je hotová v `@trailpack/sync`.
