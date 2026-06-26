# Bygge-ordre: Havstund AI-brain — for skrive-kapabel kode-karri

> Laget av karri 4 (arkitekt, read-only) 2026-06-26. Operator har godkjent bygging, men karri 4 koder ikke.
> **Denne ordren utfoeres ende-til-ende i EN sleng av en skrive-karri.** Full arkitektur-detalj: `docs/AI-BRAIN-DESIGN.md` (les den FOERST).
> Maal: komplett, testet, skuddsikker kodebase paa en branch -> PR mot CI-gated main. Operator gjoer de 4 koble-paa-stegene til slutt.

## 0. Forutsetninger / verifiser FOERST mot gjeldende main
Main er na CI-gated (branch protection, paakrevd `test`-check, strict, ingen direkte push). Fase 1+2+3 er landet. FOER du bygger:
- `git pull` main, les FAKTISK ruter/lib som finnes na (k5 landet mer enn AI-BRAIN-DESIGN.md antok): bekreft `lib/audit.js`, `lib/email.js`, `routes/availability.js` (PUT atomisk), `routes/hours.js`, `routes/staff.js`, `routes/gdpr.js`, `routes/bookings.js` (kapasitetssjekk i withTransaction), `/api/health` (ekte db.ping), `eslint.config.js` flat, vitest-oppsett. **Map brain-verktoeyene mot disse ekte rutene/tabellene — ikke mot antatte.**
- Repo-rot = `nettside/` (package.json ligger der). Derfor: legg `havstund-brain/` som UNDERMAPPE i repo-rot (`nettside/havstund-brain/`), eget npm-package. Da: ett repo, en PR, CI paths-filter virker. (Korrigerer "soesken"-formulering i design-doc.)
- Branch: `feat/ai-brain` ut fra main.

## 1. Byggesekvens (én sleng, men i denne rekkefoelgen for groenne tester underveis)

**Steg A — skjelett + kontrakt (null nettside-endring):**
- `havstund-brain/` med eget `package.json` (pinned: `@anthropic-ai/sdk`, `zod`, `undici`, `pino`, `vitest`), `tsconfig.json`, `.gitignore` (.env, dist, node_modules), `.env.example`, `README.md`.
- `src/config.ts` (zod fail-fast paa env), `src/port/website-port.ts` (abstrakt kontrakt), `src/port/types.ts`, `src/port/errors.ts`, `src/adapters/mock-website-adapter.ts`.
- `test/port-contract.test.ts` (kjoeres mot mock). `npm test` groenn.

**Steg B — verktoey + bekreft-foer-skriv-loop (mot mock):**
- `src/brain/tools.ts` (lese: list_bookings, get_booking, check_availability, get_opening_hours, list_activities, list_messages, get_message_thread, get_content, list_staff_hours; skrive m/ `strict:true`+`additionalProperties:false`: create_booking, update_booking, set_booking_status, set_availability, set_opening_hours, upsert_activity, set_activity_status, reply_to_customer, log_staff_hours, update_site_content). Idempotency_key paa oppretting, expected_updated_at/version paa endring.
- `src/brain/agent.ts` manuell loop + `tool_choice:{type:'auto',disable_parallel_tool_use:true}`; skrive-tool PAUSER -> forslag; `/confirm` re-validerer mot fersk DB -> utfoerer EN skriving. `src/brain/system-prompt.ts`.
- `pending_actions` + `audit`-persistens (egen tabell ELLER gjenbruk nettsidens `lib/audit.js` via porten). Anthropic-stub (`test/anthropicStub.ts`) — scriptede tool_use/text/refusal-turer. `test/agent.test.ts`, `test/tools.test.ts`. Meta-test: hvert skrive-verktoey MAA ha propose+execute+forged-token-test + domene. `npm test` groenn, ingen ekte Claude.

**Steg C — laerings-/minne-hjerne:**
- Migrasjon `lessons`-tabell (CHECK domain IN booking/timesheet/calendar/customer/global, version/supersedes/status/entity_ref/confidence/source). `src/brain/memory/` med EN router `writeLesson` (domene-match + schema-valider + assertNoHardState), verktoey `save_lesson`/`retire_lesson`/`correct_lesson` (domain=strict enum). `getRelevantLessons(domain, entityRef)` injiserer kun relevante lessons.
- Domene-isolasjons-evals (scorer paa HANDLINGER ikke prosa): ingen kryss-domene-skriv, ingen dobbeltbooking, riktig store, laerte korreksjoner anvendt. `npm test` groenn.

**Steg D — ekte adapter + nettside-rolle:**
- `src/adapters/http-website-adapter.ts` (undici, service-token-header) mappet mot FAKTISKE ruter fra steg 0. `src/server/http.ts` (`POST /agent/ask`, `/agent/health`) + `src/server/auth.ts` (verifiser operatoer-token).
- Nettside: ny rolle `agent` (smalere enn admin) som service-token mapper til. Nightly kontrakt-test mock↔ekte API (bak env-flagg, ikke commit-CI).

**Steg E — nettside-shim + utvalgt-admin + frontend (alt bak BRAIN_ENABLED):**
- `nettside/integrations/brain-shim.js` (returnerer umiddelbart hvis `BRAIN_ENABLED!=='true'`; ellers EN proxy-rute `/api/brain/ask` bak `requireRole('admin')` + `ai_agent_enabled`). EN linje i `server.js`: `require('./integrations/brain-shim')(app)`.
- Migrasjon: `ai_agent_enabled BOOLEAN DEFAULT false` paa users (idempotent i schema.sql). `/api/auth/me` returnerer flagget.
- Frontend: chat-panel i `intranett.html` + `js/agent.js`, vises KUN hvis flagget; "Send"-knapp per forslag.
- Av/paa-bevis-tester: BRAIN_ENABLED=false -> rutebord byte-identisk; =true -> 401 anon/403 ikke-admin/403 admin-uten-flagg/200 utvalgt.

**Steg F — CI + go/no-go:**
- `.github/workflows/havstund-brain.yml` (`paths:["havstund-brain/**"]`, working-directory havstund-brain, install+typecheck+test+`npm audit`+secret-scan, INGEN API-noekkel i commit-jobb). `nightly-live` separat, ikke merge-blokkerende.
- Kjoer go/no-go-sjekkliste (alle groenne kreves): tester+tsc; ingen skrive uten confirm; audit; rate-limit(429); secrets ute av git; minne-domene-isolasjon; refusal/feil; idempotens; fake↔ekte-kontrakt (nightly).

## 2. Landing
- Commit i logiske bolker, push `feat/ai-brain`, aapne PR mot main. **CI `test`-check MAA vaere groenn** (branch protection krever den). Ikke merge foer groenn.
- Hold nettsidens eksisterende suite (108→nyere) groenn — ikke bryt den.

## 3. Operator koble-paa-steg (kan IKKE gjoeres av Claude-pane — gjenstaar uansett)
1. Merge PR (eller la operator merge etter review).
2. Sett `ANTHROPIC_API_KEY` som Railway-secret (kun brain-prosessen).
3. Deploy `havstund-brain`-prosessen + sett `BRAIN_URL`/`BRAIN_SERVICE_TOKEN`/`BRAIN_OPERATOR_TOKEN`.
4. Flipp `BRAIN_ENABLED=true` + sett `ai_agent_enabled=true` for din admin-bruker. Test foerst med `confirm:false` (skygge) -> saa skriving.

## 4. Modell/SDK
`claude-opus-4-8`, `thinking:{type:'adaptive'}`, `output_config:{effort:'high'}`, `@anthropic-ai/sdk`. Manuell loop (IKKE auto tool_runner — det bryter foreslå-foer-skriv).
