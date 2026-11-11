# TrailPack – architektura

> Your intelligent outdoor companion. Offline‑first aplikace pro plánování turistiky, bivakování,
> kempování, ultralehkých výprav a bikepackingu (Android, iOS, web).

## 1. Přehled

```
┌──────────────────────────── apps/mobile (Expo SDK 58, RN 0.88, expo-router) ───────────────────────────┐
│  UI (obrazovky, design system, grafy, mapa)  ──►  hooks / stores (zustand, TanStack Query)            │
│        │                                              │                                               │
│        ▼                                              ▼                                               │
│  services/ (composition root) – propojuje doménové balíčky s platformou (SQLite, SecureStore, GPS)    │
└───────┬───────────────┬───────────────┬───────────────┬───────────────┬───────────────┬──────────────┘
        │               │               │               │               │               │
  @trailpack/      @trailpack/     @trailpack/     @trailpack/     @trailpack/     @trailpack/
  database         routing         maps            weather         gear            ai
  (SQLite, repo,   (BRouter,       (styly, offline (Open-Meteo,    (hmotnost, UL   (poskytovatelé,
  migrace, zálohy) Valhalla, ORS,  dlaždice, geo-  rizika, výbava  optimalizátor,  agent loop, tools,
        │          GraphHopper,    kódování, POI   dle počasí)     balení,         plánovač výprav,
  @trailpack/sync  Mapy.com)       Overpass)                       checklisty)     doporučení)
        │               │               │               │               │               │
        └───────────────┴──── @trailpack/calculations (deterministické výpočty) ┴───────────────┘
                                         │
                               @trailpack/shared (zod modely, chyby, HTTP, cache, jednotky, katalog služeb)

apps/api (Hono, Node 22) – volitelný backend: AI proxy (klíče jen na serveru), synchronizace, sdílení výprav,
                           limity a účtování AI, GDPR export/smazání. Úložiště SQLite nebo PostgreSQL.
```

## 2. Zásady

| Zásada | Realizace |
|---|---|
| **Offline‑first** | Lokální SQLite je zdroj pravdy (expo-sqlite na zařízení, sql.js + IndexedDB na webu). Síť je jen zdroj dat a synchronizace. |
| **Oddělení výpočtů od AI** | Hmotnosti, vzdálenosti, časy, voda, energie, palivo, baterie, rozpočet = `@trailpack/calculations`, `gear`, `nutrition`. AI je volá přes nástroje, nikdy je nevymýšlí. |
| **Skutečná data** | Trasy z routovacích enginů, počasí z Open‑Meteo, POI z OpenStreetMap (Overpass), výšky z DEM. Každý údaj nese zdroj a čas získání. |
| **Adaptéry poskytovatelů** | Každá externí služba je za rozhraním (`RoutingProvider`, geocoder, `OpenMeteoProvider`, `ChatTransport`). Výměna poskytovatele = nový adaptér. |
| **Hexagonální AI** | `@trailpack/ai` definuje porty (`ToolPorts`); aplikace je implementuje skutečnými službami. Díky tomu je AI vrstva testovatelná a nezávislá na platformě. |
| **Bezpečnost klíčů** | Žádné klíče v kódu. Uživatelské klíče v SecureStore (zařízení) nebo jen na serveru (`apps/api`, režim proxy). |
| **Transparentní nejistota** | Odhady mají příznak `estimated`, `confidence`, text nejistoty; předpověď mimo horizont se nezobrazuje jako předpověď; právní status nocování má 4 úrovně a zdroj. |
| **Validace** | zod schémata na všech hranicích (DB, import, API, AI nástroje). |
| **Centralizované chyby** | `TrailPackError` s kódy (`network`, `offline`, `not_configured`, `rate_limited`, `no_route` …) → lokalizované zprávy v UI. |

## 3. Balíčky

| Balíček | Odpovědnost |
|---|---|
| `shared` | Doménové modely (zod) pro všech 28 entit, `TrailPackError`, `HttpClient` (timeouty, retry, throttling dle pravidel OSM služeb), cache se stale‑if‑error, jednotky a formátování, katalog poskytovatelů (`PROVIDERS`, `ENDPOINTS`). |
| `calculations` | Geodézie, převýšení s hysterezí, časový model DIN 33466 + cyklistický model, etapy, východ/západ slunce (NOAA), obtížnost, denní harmonogram, voda, energie (Pandolf), elektronika ve Wh, rozpočet, statistiky, GPS záznam a sledování trasy. |
| `formats` | GPX/KML/GeoJSON import/export (bezpečný XML parser, limity velikosti), tiskový report výpravy (HTML → PDF). |
| `routing` | Adaptéry BRouter, Valhalla, openrouteservice, GraphHopper, Mapy.com, ruční (offline) režim, služba s fallbackem, porovnání tras, okruhy, výšky (Open‑Meteo elevation). |
| `maps` | Katalog mapových stylů a překryvů, skládání MapLibre stylů, matematika dlaždic a limity offline balíčků, geokódování (Photon/Nominatim/Mapy.com), POI z Overpass (voda, nocoviště, vrcholy, chráněná území). |
| `weather` | Open‑Meteo, horizont předpovědi, počasí podél trasy dle času průchodu, rizika, doporučení výbavy, porovnání termínů. |
| `regulations` | Dataset pravidel nocování a ohně (CZ, SK, PL, AT, DE, CH) se zdroji a datem revize, rozhodovací engine, detekce země, nouzová čísla. |
| `gear` | Hmotnost batohu (base/worn/consumable), UL optimalizátor (knapsack, bezpečnostní omezení), asistent balení, checklisty, import/export (CSV vč. LighterPack, JSON), šablony sestav. |
| `nutrition` | Databáze potravin (typické hodnoty – k ověření dle etikety), jídelníček, souhrny, palivo. |
| `ai` | Poskytovatelé (Anthropic, OpenAI, Gemini, OpenAI‑kompatibilní/lokální), proxy transport, agent loop s potvrzováním změn, ochrana proti prompt injection, nástroje, plánovač expedic, pravidlová doporučení. |
| `database` | SQL driver abstrakce (expo-sqlite, sql.js, node:sqlite), migrace, repozitáře, outbox pro sync, zálohy, diagnostika. |
| `sync` | Synchronizační engine (push/pull, LWW + evidence konfliktů, tombstones, backoff). |
| `ui` | Design tokeny (světlý, tmavý a venkovní vysokokontrastní režim). |

## 4. Datový model

Entity: UserProfile, Trip, TripDay, Route (+ RouteWaypoint, RouteSegment), GPSActivity (+ body v tabulce
`gps_points`), GearItem, GearCategory, GearLoadout, LoadoutItem, FoodItem, MealPlan, WaterSource, Campsite,
FavoritePlace, WeatherSnapshot, BatteryDevice, PowerPlan, Checklist, ChecklistItem, Expense, TripParticipant,
PhotoEntry, JournalEntry, TripComment, AIConversation, AIMessage, OfflineRegion, AppSettings.

Každá synchronizovaná entita má `id`, `createdAt`, `updatedAt`, `deletedAt` (tombstone). V SQLite je uložena jako
JSON (`data`) + indexované sloupce pro cizí klíče. Podrobnosti v [docs/DATABASE.md](docs/DATABASE.md).

## 5. Tok „naplánuj mi výpravu“

1. Text → `parseTripRequest` (pravidlový, funguje offline) nebo strukturovaná extrakce přes LLM.
2. Geokódování oblasti → vrcholy (Overpass) → kandidátní hřebenové trasy → routování (BRouter/Valhalla…).
3. Porovnání variant → volba → rozdělení na etapy (časový model) s ukotvením na legální nocoviště.
4. Kontrola pravidel nocování v místě (země + chráněná území) → jen ověřená/podmíněná místa.
5. Voda podél trasy → plán doplňování; počasí podél trasy (jen v horizontu předpovědi).
6. Výbava ze sestavy → hmotnost → UL návrhy; jídelníček, energie, palivo, elektronika.
7. Itinerář, checklist, rizika a nejistoty → návrh výpravy → po potvrzení uložení do DB.
Každá změna (km/den, počet dní, typ spaní, datum, sestava) přepočítá jen závislé části (`recalculatePlan`).

## 6. Offline

| Funkce | Offline |
|---|---|
| Výpravy, výbava, checklisty, deník, statistiky, výpočty | ✅ lokální DB a deterministické výpočty |
| Mapa | ✅ v rozsahu stažených offline oblastí (MapLibre offline packs, jen styly s povoleným offline užitím) |
| GPS poloha, záznam GPX, navigace po stopě | ✅ |
| Uložené POI, trasy, výškové profily | ✅ |
| Počasí | ⚠️ poslední stažená data s časem aktualizace |
| Routování | ⚠️ jen ruční režim (spojnice bodů, jasně označeno); offline routovací graf není součástí aplikace |
| Generativní AI | ❌ vyžaduje internet nebo lokální OpenAI‑kompatibilní server v síti; pravidlové plánování a doporučení fungují offline |

## 7. Bezpečnost

Viz [docs/SECURITY.md](docs/SECURITY.md): klíče v SecureStore / na serveru, hashované tokeny, rate limiting,
limity velikosti těl a importů, XXE‑bezpečné XML, ochrana proti prompt injection, GDPR export a smazání,
žádná data bez souhlasu mimo zařízení.
