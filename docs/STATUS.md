# TrailPack – stav implementace

Stav k 2026-11-11. Projekt **není** ve verzi 1.0.0 – definice hotového produktu (zadání §45) zatím není
splněna. Tento dokument je pravdivý přehled toho, co existuje, co je ověřené a co chybí.

Legenda: ✅ hotovo a otestováno · 🟡 implementováno, neověřeno na reálném zařízení / proti živé službě ·
⛔ blokováno externím přístupem · ❌ nedokončeno

## Doménové balíčky (`packages/*`)

| Oblast | Stav | Poznámka |
|---|---|---|
| Datové modely (28 entit, zod) | ✅ | `@trailpack/shared` |
| HTTP klient (timeouty, retry, throttling dle pravidel OSM služeb), cache se stale‑if‑error | ✅ | |
| Výpočty: vzdálenost, převýšení, čas (DIN 33466 + cyklo), etapy, slunce (NOAA), obtížnost, harmonogram | ✅ | 83 testů |
| Výpočty: voda, energie (Pandolf), elektronika ve Wh, rozpočet + vyrovnání, statistiky, GPS záznam, sledování trasy | ✅ | |
| Výbava: hmotnost (base/worn/consumable), UL optimalizátor, balení, checklisty, CSV/LighterPack/JSON, šablony | ✅ | 36 testů |
| Jídlo: databáze 52 potravin (typické hodnoty, označeno jako odhad), jídelníček, palivo | ✅ | 17 testů |
| GPX / KML / GeoJSON import & export, tiskový report (HTML → PDF) | ✅ | |
| Routování: BRouter, Valhalla (testy nad reálnými odpověďmi) | ✅ | |
| Routování: openrouteservice, GraphHopper, Mapy.com | 🟡 | implementováno dle dokumentace, bez API klíče neověřeno živě |
| Mapy: katalog stylů, překryvy, dlaždice a limity offline balíčků, geokódování (Photon, Nominatim, Mapy.com), POI z Overpass | ✅ / 🟡 | Mapy.com bez klíče neověřeno |
| Počasí: Open‑Meteo, horizont, počasí podél trasy, rizika, výbava dle počasí, porovnání termínů | ✅ | testy nad reálnými odpověďmi Open‑Meteo |
| Pravidla nocování CZ/SK/PL/AT/DE/CH | 🟡 | **sestaveno bez ověření proti textům zákonů** (`reviewMethod: 'unconfirmed'`), konzervativní stavy; nutná právní revize |
| Detekce země, nouzová čísla | ✅ / 🟡 | hrubé polygony (přesnost ~5–10 km) |
| Databáze: drivery (expo-sqlite, sql.js, node:sqlite), migrace, repozitáře, outbox, zálohy | ✅ | |
| Synchronizace (push/pull, LWW, konflikty, backoff) | ✅ | testováno se simulovaným serverem |
| AI poskytovatelé: Anthropic, OpenAI, Gemini, OpenAI‑kompatibilní, proxy | 🟡 | testováno s mock odpověďmi; bez API klíčů neověřeno živě |
| AI agent loop, potvrzování změn, ochrana proti prompt injection, historie, cache | ✅ | |
| AI nástroje (23), plánovač expedic, přepočet plánu, pravidlová doporučení | ✅ | testováno s fake porty |

## Backend (`apps/api`)

| Oblast | Stav |
|---|---|
| Hono server: health/meta, anonymní registrace zařízení, AI proxy s povolenými modely, rozpočtem a rate limitingem | ✅ 5 testů + spuštěný build ověřen |
| Endpointy synchronizace a sdílení výprav, GDPR export/smazání, perzistentní úložiště (SQLite/PostgreSQL) | ❌ (tokeny a využití zatím v paměti) |
| Nasazení | ❌ nenasazeno (Dockerfile připraven) |

## Mobilní / webová aplikace (`apps/mobile`)

| Oblast | Stav |
|---|---|
| Design system (světlý, tmavý, venkovní kontrastní režim), UI kit (~35 komponent), ikony, grafy (výškový profil, koláč, sloupce, trend, kalendář) | ✅ kód, 🟡 vizuálně ověřena jen domovská obrazovka |
| i18n cs / en / sk / pl / de | ✅ |
| Navigace (5 záložek + Nastavení), domovská obrazovka (offline výpočet slunce) | ✅ web ověřen v prohlížeči |
| Lokální databáze (web: sql.js + IndexedDB, native: expo-sqlite) a React Query hooky | ✅ web: uložení výbavy přežije obnovení stránky; 🟡 native neověřeno |
| Mapa (MapLibre web/native, OpenFreeMap, trasa, dlouhý stisk → souřadnice + kopírování) | ✅ web vykresluje dlaždice; 🟡 native neověřeno; ❌ POI, měření, přetahování bodů, poloha uživatele |
| Výpravy: nová výprava (vyhledání míst Photon → trasa BRouter → etapy), detail s mapou, výškovým profilem, etapami, předpovědí (≤ 16 dní), odhadem vody a exportem GPX | 🟡 implementováno, celý tok neprošel automatickým testem |
| Výbava: evidence, mazání s undo, hmotnost base/worn/consumable, třída, koláčový graf | ✅ web (smoke test) |
| AI: offline rozbor zadání → předvyplnění výpravy; chat s vlastním klíčem (bez nástrojů) | 🟡 bez klíče neověřen chat |
| Nastavení: téma, jazyk, poskytovatel AI, model, klíč (native SecureStore, web jen v paměti) | 🟡 nastavení se zatím neukládají mezi spuštěními |
| Počasí, statistiky, bezpečnost/SOS, kalkulačky, offline mapy, diagnostika, GPS záznam, sestavy výbavy, jídlo, rozpočet, deník, skupiny, notifikace, hlas, AI agent s nástroji v UI | ❌ (doménová logika hotová v balíčcích, UI chybí) |
| Texty obrazovek přes i18n (en/sk/pl/de) | ❌ nové obrazovky mají zatím pevné české texty |
| Webový build (`expo export`) | ✅ |

## Testy a build

| Položka | Stav |
|---|---|
| Unit + integrační testy | ✅ 645 / 645 (34 souborů) |
| TypeScript strict (všech 15 workspace) | ✅ |
| ESLint | ✅ 0 chyb, 0 varování |
| E2E (Playwright) | ❌ konfigurace připravena, testy nenapsány |
| Akceptační scénář „Beskydy“ (§39) end‑to‑end v UI | ❌ (plánovač je otestován na úrovni balíčku s fake porty) |
| Android APK | 🟡 toolchain ověřen v kontejneru (SDK 37, NDK, JDK 17, Gradle 9.4, prebuild); build se zastavil na stahování závislostí (HTTP 429 z Maven Central přes sdílenou bránu). CI workflow pro APK/AAB připraven |
| iOS build | ⛔ vyžaduje macOS / Apple účet (konfigurace připravena v app.json) |

## Externí služby

| Služba | Bez klíče | Poznámka |
|---|---|---|
| OpenFreeMap, Waymarked Trails, OpenTopoMap, AWS Terrain Tiles, EOX S2 cloudless 2016 | ✅ | dodržovat podmínky, žádné hromadné stahování mimo povolené offline balíčky |
| BRouter, Valhalla (FOSSGIS), Photon, Nominatim, Overpass, Open‑Meteo | ✅ | fair‑use; Open‑Meteo zdarma jen nekomerčně |
| Mapy.com, openrouteservice, GraphHopper | ⛔ klíč | |
| OpenAI, Anthropic, Gemini | ⛔ klíč (placené API kredity) | předplatné chatovací aplikace se nepočítá |
| Lokální model (Ollama / LM Studio) | ✅ | běží na počítači v síti, ne v telefonu |

## Další kroky (pořadí)

1. Datová vrstva aplikace: drivery, služby, implementace `ToolPorts`, React Query hooky.
2. Mapa (MapLibre) + plánovač tras + výškový profil + POI.
3. Obrazovky Výpravy (etapy, itinerář, voda, jídlo, energie, rozpočet, checklist, deník), Výbava (sestavy, grafy, UL, balení), AI chat.
4. GPS záznam a navigace (foreground service), offline mapy, bezpečnost/SOS, notifikace, hlas.
5. Playwright E2E včetně akceptačního scénáře a výpadků služeb; Android APK v CI.
6. Právní revize datasetu pravidel nocování.
