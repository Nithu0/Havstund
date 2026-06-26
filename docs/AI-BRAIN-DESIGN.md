# Havstund Brain — frittstående, pluggbar AI-agent med lærings-hjerne

> Master-arkitektur. Laget av karri 4 (firm8) 2026-06-26 via 4 parallelle design-agenter + `gh`-verifiserte repo-fakta.
> **Status: DESIGN — ikke bygget.** Min rolle (løsnings-arkitekt) koder ikke. En skrive-karri bygger dette.
> Bygges i EGEN mappe `havstund-brain/` (søsken til `nettside/`), kobles på/av, skuddsikker FØR påkobling.

## Operatørkrav (kilde)
1. AI-agent inne i admin som kan **handle på nettsiden** (svare kunder, opprette/endre booking/time, endre innhold/kalender).
2. **Foreslå → "send"/bekreft** før noe utføres.
3. **Kun utvalgte admin** (ikke alle admin).
4. **Egen trenings-/lærings-hjerne** som husker alt og IKKE roter til kalender/blander timeliste.
5. **Egen mappe utenfor nettsiden**, kan **kobles på og av**, **skuddsikker** før påkobling.

## GitHub-fakta (gh, 2026-06-26)
- Repo `Nithu0/Havstund` (node-id `R_kgDOTAOScg`), PUBLIC, default `main`. Ingen åpne issues.
- 8 åpne Dependabot-PR-er: **express 4→5 (MAJOR)**, **vitest 2→4 (MAJOR)**, dotenv 16→17, pino-http 10→11, eslint-config-prettier 9→10, + 3 GH-Actions-bumps (#1–8).
- Branches: `main`, `fase-1-infra-sikkerhet` + 8 dependabot-branches.
- **Konsekvens:** hjernen får EGET `package.json`/lockfile → pinner egne deps uavhengig av nettsidens express-5-risiko. Ikke del workspace.

---

## 1. Koblingsmønster — VALGT: separat prosess + REST + service-token

Tre mønstre vurdert; valgt (a):
- **(a) Separat prosess, snakker med nettsidens REST-API over HTTP med service-token.** ✅ Best isolasjon (egen krasj-grense), av/på = drep prosess, arver nettsidens validering/idempotens/Socket.IO gratis, smal revokerbar `agent`-rolle.
- (b) npm-pakke bak flag — ❌ kjører i nettsidens prosess (SDK-krasj/loop river ned nettsiden), deps ligger i nettsidens hot path.
- (c) sidecar mot delt Postgres — ❌ rå SQL omgår all validering + Socket.IO, to sannhetskilder.

Dataflyt: `admin-UI → POST /api/brain/ask (shim, requireRole admin + utvalgt-flagg) → brain /agent/ask (operatør-token) → runAgent → Claude tool-loop → WebsitePort → HttpAdapter → REST /api/* (service-token, rolle 'agent') → lib/db.js`.

## 2. Mappestruktur `havstund-brain/`
```
havstund-brain/
  package.json            # @anthropic-ai/sdk, zod, undici, pino, vitest (egne, pinned)
  .env.example .gitignore README.md
  src/
    index.ts config.ts                      # config: zod fail-fast på env ved oppstart
    brain/ agent.ts system-prompt.ts tools.ts
    port/  website-port.ts types.ts errors.ts
    adapters/ http-website-adapter.ts mock-website-adapter.ts
    server/ http.ts auth.ts
    lib/ http-client.ts logger.ts
  test/ agent.test.ts http-adapter.test.ts tools.test.ts port-contract.test.ts
```
- `agent.ts` kjenner KUN `WebsitePort` (ikke adapter, ikke Express/pg). Injiseres → testbar mot mock.
- `WebsitePort` = abstrakt kontrakt (listBookings/createBooking/updateBooking/listMessages/replyToMessage/getContent/updateContent/setAvailability/health). `HttpWebsiteAdapter` (ekte REST) + `MockWebsiteAdapter` (in-memory) består SAMME kontrakt-test.

## 3. Av/på-mekanisme (`BRAIN_ENABLED`)
Eneste nettside-endring: én ny fil `integrations/brain-shim.js` + én linje i `server.js` (`require('./integrations/brain-shim')(app)`).
- `BRAIN_ENABLED !== 'true'` → shim returnerer umiddelbart: ingen rute, ingen UI, ingen deps i hot path, null påvirkning. `@anthropic-ai/sdk` finnes ikke i nettsidens package.json i det hele tatt.
- `=true` → én tynn proxy-rute `/api/brain/ask` bak `requireRole('admin')` + utvalgt-admin-flagg. Frontend gater chat-panelet på samme flagg.
- **Skygge-/dry-run-trinn FØR ekte påkobling:** `confirm:false` → agenten leser + foreslår, men skrive-verktøy treffer ALDRI porten. Verifiser i prod read-only før skriving slås på.

## 4. Utvalgt-admin (ikke alle admin)
Ny kolonne `ai_agent_enabled BOOLEAN DEFAULT false` på `users` (idempotent i `schema.sql`). Sett `true` manuelt for valgte. Gate = `requireRole('admin') && req.user.ai_agent_enabled` (to UAVHENGIGE lag). Frontend viser panelet kun hvis `/api/auth/me` returnerer flagget.

## 5. Verktøykatalog (komplett — agentens "fulle tilgang = allowlisten")
Ingen shell/fs/git/MCP. Kun katalogiserte verktøy.

**LESE (auto-kjør, muterer ikke):** `list_bookings`, `get_booking`, `check_availability` (kapasitet — kall ALLTID før booking), `get_opening_hours`, `list_activities`, `get_activity`, `list_messages`, `get_message_thread`, `get_content`, `list_staff_hours`.

**SKRIVE (krever bekreftelse, `strict:true`, `additionalProperties:false`):** `create_booking`, `update_booking`, `set_booking_status`, `set_availability`, `set_opening_hours`, `upsert_activity`, `set_activity_status`, `reply_to_customer`, `log_staff_hours`, `update_site_content`. Alle med `idempotency_key` (oppretting) eller `expected_updated_at`/`expected_version` (stale-write-vakt).

## 6. Foreslå → send (bekreft-før-skriv)
**Manuell agent-loop (IKKE auto tool_runner)** + `tool_choice:{type:'auto', disable_parallel_tool_use:true}`:
- `POST /message`: kjør lese-verktøy automatisk; når Claude emitterer et SKRIVE-`tool_use` → STOPP, lagre `PendingAction` (i Postgres `pending_actions`, ikke minne), returner rendret forslag + `tool_use_id`. Ingenting skrevet.
- `POST /confirm {tool_use_id}`: hent pending → **re-valider mot fersk DB** (kapasitet, gyldig statusovergang, stale-write, idempotens) → utfør ÉN skrivekall → audit → mat `tool_result` tilbake → Claude oppsummerer.
- `strict:true` garanterer schema, men harde grenser (hours≤24, party_size≤kapasitet, pris≥0) håndheves i revalidering (strict støtter ikke minimum/maxLength).

## 7. Lærings-/minne-hjerne (kjernen i operatørkravet)
**Prinsipp: Postgres = sannhet for HARDE fakta; minne-laget = ERFARING (preferanser, korreksjoner, mønstre, profiler) — aldri fersk tilstand.** Da kan minnet aldri bli stale og aldri overstyre DB.

- **4 isolerte domener + `_global`:** `booking / timesheet / calendar / customer`. Hvert minne bærer obligatorisk `domain`-tag.
- **Strukturert Postgres `lessons`-tabell** (IKKE fil-per-lærdom) — gir maskinhåndhevet domene-separasjon via `CHECK (domain IN (...))`, audit (`version`/`supersedes`), soft-delete (`status`), FK-`entityRef`. Eksponer som memory-verktøy (`save_lesson`/`retire_lesson`/`correct_lesson`) med `domain` som **strict enum**.
- **Anti-rot:** én `writeLesson`-router er eneste skrivevei: (1) domene må matche intent, (2) `type` lovlig i domenet, (3) payload validerer mot domene-schema, (4) `assertNoHardState` blokkerer at f.eks. `bookingStatus`/`hoursLogged` havner i minnet. Kryss-domene-skriv kastes.
- **Lærings-loop (uten ML):** FANG admin-korreksjon ("Per jobber ikke lørdager") → DERIVE typet regel (`confidence`, `source:'admin_correction'`) → LAGRE versjonert → INJISER kun relevante lessons (`getRelevantLessons(domain, entityRef)`) i prompt ved neste relevante oppgave.
- **Retrieval-regel:** harde fakta (er booking bekreftet? ledige plasser?) → ALLTID DB, ingen minne-fallback. Avledede mønstre → `entityRef`+TTL, re-deriveres.
- Context editing (`clear_tool_uses_20250919`) rydder transient samtale-kontekst i loopen — IKKE minne-laget. Korttidsminne (sesjon) vs langtidsminne (lessons-tabell) holdes adskilt.

## 8. Skuddsikkerhets-rails
Audit-tabell (2 rader/handling: `proposed` + `executed`, hvem/hva/når/diff); idempotens (unik DB-constraint på `idempotency_key` + pending-status-sjekk → confirm 2× ≠ 2 bookinger); rate-limit per-admin på `/message` og `/confirm`; `CONFIRM_TTL` (~15 min); refusal-håndtering (sjekk `stop_reason` FØR `content`); tool-feil som `is_error` (ikke kastet exception); `tool_choice` aldri tvunget til skrive-verktøy; secrets (`ANTHROPIC_API_KEY`, service-token, operatør-token) kun server-side, aldri frontend/git.

## 9. Test / "alt grønt" / go-no-go
- **3 tvangs-invarianter håndhevet av verktøy-register + meta-test:** (1) lese muterer ikke (snapshot før==etter), (2) skrive krever kryptografisk confirm-handshake (HMAC-token over forslag), (3) minne-domener er fysisk isolerte namespaces.
- **LLM-uavhengig:** injiser scriptet Anthropic-stub (`messages.create` returnerer kø av tool_use/text/refusal-turer). Ingen ekte Claude i commit-CI → raskt, deterministisk, gratis.
- **Eval scorer på HANDLINGER (verktøy-kall + port-state), ikke prosa:** beviser ingen domeneblanding, ingen dobbeltbooking, riktig minne-store, lærte korreksjoner anvendt.
- **Av/på-bevis:** `BRAIN_ENABLED=false` → rutebord byte-identisk med bygg uten modulen; `=true` → 401 anon / 403 ikke-admin / 403 admin-uten-flagg / 200 utvalgt admin.
- **Go/no-go (alle grønne kreves):** tester grønne + `tsc` ren; ingen skrive-verktøy uten propose/confirm/forged-token-test; audit verifisert; rate-limit verifisert (429); secrets ute av git (git grep-gate); minne-domene-isolasjon; refusal/feil håndtert; idempotens; fake↔ekte-kontrakt grønn (nightly).
- **CI:** egen `.github/workflows/havstund-brain.yml` med `paths: ["havstund-brain/**"]` + `working-directory: havstund-brain` — adskilt fra nettsidens CI, ingen API-nøkkel i commit-jobben. `nightly-live` (ekte Claude + ekte API) er separat og IKKE merge-blokkerende.

## 10. Byggerekkefølge (for skrive-karri)
1. Skjelett `havstund-brain/` + `package.json` (pinned) + config fail-fast + `WebsitePort` + `MockWebsiteAdapter` + kontrakt-test. (Ingen nettside-endring.)
2. Verktøykatalog (lese+skrive) + manuell loop + pending/audit + Anthropic-stub-tester. Alt mot mock → grønt.
3. Lessons-tabell + router + memory-verktøy + domene-isolasjons-evals.
4. `HttpWebsiteAdapter` mot ekte API + service-token + `agent`-rolle på nettsiden + nightly-kontrakt.
5. Nettside-shim (`brain-shim.js` + 1 linje) + `ai_agent_enabled`-flagg + frontend-panel, alt bak `BRAIN_ENABLED`.
6. Go/no-go-sjekkliste grønn → skygge (`confirm:false`) i prod → så skru på skriving.

**Modell:** `claude-opus-4-8`, `thinking:{type:'adaptive'}`, `output_config:{effort:'high'}`, `@anthropic-ai/sdk`.
