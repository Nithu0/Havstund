# Havstund — Komplethets-veikart (admin + infrastruktur)

> **Delt arbeidsdokument.** Dette er sannhetskilden for "gjøre Havstund komplett".
> Åpne prosjektet fra hvilken som helst terminal og les denne fila først.
> Oppdater statusboksene (`[ ]` → `[x]`) når noe er gjort, og noter commit-SHA.
>
> Generert av firm-gjennomgang (karri 1-8) 2026-06-24. Funn er verifisert mot faktisk kode.

## Arbeidsdeling (avtalt 2026-06-24)
- **Fase 1** kjøres på branch `fase-1-infra-sikkerhet` (denne sesjonen).
- **Fase 2 og Fase 3** tas opp parallelt fra andre terminaler. Lag egne branch-er
  (forslag: `fase-2-admin`, `fase-3-robusthet`) ut fra `main` etter at Fase 1 er merget,
  eller ut fra `fase-1-infra-sikkerhet` hvis dere trenger CI/test-oppsettet med en gang.
- Koordinér via denne fila: kryss av, skriv hvem/hvilken terminal som tar en rad.

---

## Kontekst (verifiserte fakta)
- Stack: Node/Express + Socket.IO + Postgres, deploy på Railway (`railway.json`, Nixpacks). Helse: `GET /api/health`.
- Auth: JWT i httpOnly-cookie (`lib/auth.js`), roller `kunde|ansatt|admin`. Admin-dashbord: `public/intranett.html` + `routes/admin.js`.
- GitHub `Nithu0/Havstund` er **PUBLIC**, default branch `main`. **Ingen CI, ingen branch protection, ingen tester, ingen linter.**
- `.env` er ikke lekket (gitignored). MEN `.env.example` committer default `ADMIN_PASSWORD=havstund2026` og `JWT_SECRET=bytt-meg...` i et public repo.

## Bekreftede bugs (ikke bare manglende funksjoner)
- `routes/auth.js:38` — godtar 6-tegns passord. **(Fase 1)**
- `routes/admin.js:114` — usanitisert CMS-`nokkel` + ingen størrelsesgrense på `verdi` (bak `requireRole`, så staff-misbruk, ikke anonymt). **(Fase 1)**
- `routes/chat.js:66` — chat-cookie satt med `httpOnly:false`. **(Fase 1)**
- `routes/bookings.js:64` — MVA hardkodet til 25 % (`brutto/1.25`). **IKKE en bug:** `activities` har ingen `mva_sats`-kolonne; 25 % er korrekt for alle opplevelser i dag. Per-aktivitet-MVA er en **Fase 3**-feature (schema + UI + migrering). Fase 1 låser kun dagens matte i en testet hjelpefunksjon (`lib/regnskap.js`).

---

## A) Admin-bruker — mot komplett

### Høy impact
| Tittel | Finnes i dag | Forslag | Effort | Fase |
|---|---|---|---|---|
| Bytt admin-passord fra UI | Login + hashing finnes, ingen passordform | `POST /api/auth/change-password` (verifiser gammelt) + pane i `konto.html` | M | 2 |
| Kalender + kapasitet/overbookingsvern | `availability`-tabell finnes; booking sjekker IKKE kapasitet | kapasitets-middleware i `bookings` POST + kalendergrid | M | 2 |
| Aktivitets-CRUD fra panel | `activities` read-only (`routes/activities.js`); CMS kun key-value | POST/PUT/DELETE i `routes/activities.js` + admin-side | M | 2 |
| Kundevarsel ved statusendring | Status endres uten å varsle kunde (kun intern Discord) | `lib/email.js` (Nodemailer) + kall fra `bookings` PATCH; ulest-badge på `/min-side` | M | 2 |
| Booking-agenda / dagsvisning | "Siste bookinger" sortert på `opprettet` | `admin-agenda.html`, GET bookings filtrert `dato >= i dag` | S | 2 |
| Åpningstider + stengte dager | Ingen; booking når som helst | `business_hours` + `closed_dates`-tabeller, validering i `bookings` POST | S | 2 |

### Medium / lavere (nice-to-have for ett studio)
| Tittel | Forslag | Effort | Fase |
|---|---|---|---|
| Refusjon/avbestilling + grunn-sporing | `refund_amount/reason` på bookings + auto reverserende regnskapspost | M | 3 |
| Samlet kunde-CRM-profil | `routes/crm.js` GET `/customers/:id/profile` (join), `kunde-profil.html` | M | 3 |
| CSV/Excel-eksport bookinger + omsetning per aktivitet | `routes/export.js` GET `/export/bookings?format=csv`, LEFT JOIN activities | M | 3 |
| Personalkonto-livssyklus (invite/deaktiver) | `routes/staff.js` (list, invite m/token), `admin-staff.html` | L | 3 |
| 2FA / TOTP for admin/ansatt | speakeasy+qrcode, `totp_secret/enabled` på users | L | 3 |
| GDPR PII-eksport + sletting | `routes/gdpr.js` (export/delete-cascade), `docs/GDPR.md`, `anonymized_at` | M | 3 |
| Audit-logg av admin-handlinger | `audit_log`-tabell, logging i auth/staff/admin | M | 3 |
| Forgot-password (reset-lenke / admin-reset) | `reset_tokens`-tabell, forgot/reset endpoints | M | 3 |
| Kundesøk (server-side) + RBAC-UI | `routes/customers.js` GET `/search`; `lib/permissions.js` | M | 3 |
| Per-aktivitet analytics + CLV | GET `/admin/activity-stats` / `/customer-metrics` (Chart.js) | M | 3 |
| Per-aktivitet MVA-sats | `mva_sats`-kolonne på `activities` + migrering + bruk i `lib/regnskap.js` | M | 3 |

---

## B) Infrastruktur — mot komplett

### Høy impact
| Tittel | Finnes i dag | Forslag | Effort | Fase |
|---|---|---|---|---|
| Roter default-secrets + herd `.env.example` | Lekker `havstund2026`/`bytt-meg` i public repo | `CHANGE_ME`-verdier, bekreft Railway-override, roter `JWT_SECRET` | S | 1 |
| GitHub Actions CI | Ingenting | `.github/workflows/ci.yml` (install + audit + test) | M | 1 |
| Branch protection + required checks | `main` helt ubeskyttet (gratis — public repo) | `gh api` PUT protection, krev `test`-check + 1 review | S | 1 |
| Security headers + rate limiting | Ingen helmet; ingen brute-force-vern | `lib/security.js` (helmet + express-rate-limit), mount i `server.js` | M | 1 |
| Input-validering (passord, CMS-nøkkel, chat-cookie) | Svakt: 6-tegns pw, usanitisert nøkkel, `httpOnly:false` | Fiks de tre stedene over | S | 1 |
| Unit-tester (auth + MVA-matte) | Null tester, ingen runner | vitest, `tests/lib/auth.test.js`, `tests/lib/regnskap.test.js` | M | 1 |
| Strukturert logging + correlation IDs | Spredt `console.log/error` | `lib/logger.js` (pino) + request-middleware | M | 3 |
| Error tracking (Sentry) | Ingen | `lib/sentry.js`, hook i error-handler | M | 3 |
| DB backup + DR-plan | Railway-Postgres, idempotent schema; ingen backup | `scripts/backup.sh` (pg_dump) + `docs/BACKUP-RESTORE.md` | M | 3 |

### Medium / lavere
| Tittel | Forslag | Effort | Fase |
|---|---|---|---|
| ESLint + prettier | eslint+prettier i devDeps, lint/format-scripts | S | 3 |
| Dependabot + CodeQL | `.github/dependabot.yml` (npm weekly) + CodeQL | S | 3 |
| Ops-alerting (Discord ops-kanal) | `lib/discord-ops.js`, `DISCORD_WEBHOOK_OPS`, alarm ved DB-down/500-rate | M | 3 |
| Versjonerte migrasjoner | `schema_migrations`-tabell + node-pg-migrate | M | 3 |
| Graceful SIGTERM-shutdown | Lukk server+pool på SIGTERM | S | 3 |

> Droppet som over-engineering for ett studio: dyp readiness-probe utover dagens `/api/health`.

---

## Veikart i faser

### Fase 1 — stopp blødningen (infra + sikkerhet)  ← DENNE BRANCHEN
Et public repo uten beskyttelse + lekkede default-secrets er den eneste "kan-gå-galt-i-dag"-risikoen.
**Bindende rekkefølge for CI/protection:** push `ci.yml` FØRST (så `test`-checken har kjørt minst én gang), DERETTER branch protection — ellers låses `main` til en check som aldri rapporterer grønt.

- [x] 1. Roter default-secrets + herd `.env.example` (+ `.env.local` i `.gitignore`) — GJORT: `JWT_SECRET`/`ADMIN_PASSWORD` → `CHANGE_ME`, `.env.local` lagt til gitignore
- [x] 2. `lib/regnskap.js` — TATT I BRUK i `routes/bookings.js:64` (`mvaSplitt(belop*100, 25)`). Tall bit-identiske med gammel `brutto/1.25` (verifisert på 500/750/1200/99/3333 kr)
- [x] 3. Input-validering: `auth.js:41` min nå `MIN_PW` (env, default 8); `admin.js:119-123` validerer `nokkel` + capper `verdi` 50k; `chat.js:66` `httpOnly:true`
- [x] 4. `lib/security.js` — MOUNTET i `server.js:21` (`applySecurity(app)` før body-parsere); `helmet@8.2.0` + `express-rate-limit@7.5.1` i `package.json` + installert
- [x] 5. vitest + tester — `tests/lib/regnskap.test.js` (4) + `tests/lib/auth.test.js` (6), **10/10 grønn**. `vitest.config.js` lagt til (globals, så CommonJS-require virker)
- [x] 6. `.github/workflows/ci.yml` — fil laget. Ikke pushet til main / ingen PR ennå
- [ ] 7. **Operator kjører:** branch protection-kommando (se nederst) etter at CI har kjørt én gang

### Resume her — GJENSTÅR KUN OPERATOR-STEG (all wiring DONE + verifisert av karri 5 2026-06-25)
Alle 9 wiring-steg under er fullført og koblet inn. `npm test` grønn, `npm ci --dry-run` = lockfile i sync (CI vil kjøre). Gjenstår kun git/gh som karri 5 ikke gjør:
- Commit de endrede filene (IKKE `public/index_gammel_backup.html` — stray backup, hold utenfor), push `fase-1-infra-sikkerhet`, åpne PR mot `main`.
- PR trigger `ci.yml` → `test`-checken kjører grønt → DERETTER branch protection-kommandoen nederst.

<details><summary>Original 9-stegs wiring-spec (alle DONE)</summary>
1. **`package.json`**: legg til `helmet` + `express-rate-limit` i `dependencies`, og en devDep `vitest` + `"test": "vitest run"` i `scripts`. Kjør `npm install` (lager `package-lock.json` som `ci.yml` vil bruke).
2. **`server.js`**: `const { applySecurity } = require('./lib/security')` og kall `applySecurity(app)` rett etter `const app = express()` (før `express.json`/ruter).
3. **`routes/bookings.js:62-65`**: erstatt den manuelle `brutto/1.25`-splitten med `const { mvaSplitt } = require('../lib/regnskap')` → `const { netto_ore, mva_ore } = mvaSplitt(booking.belop * 100, 25)`. Samme tall, men nå testet.
4. **`routes/auth.js:38`**: `passord.length < 6` → konfigurerbar min (env `MIN_PASSORD_LENGTH`, default 8), oppdater feilmeldingen dynamisk.
5. **`routes/admin.js:114-117`**: valider `nokkel` mot `^[a-z0-9_.-]{1,64}$` (400 ellers) + cap `verdi`-lengde (~50 KB → 400).
6. **`routes/chat.js:66`**: `httpOnly: false` → `true`.
7. **`lib/auth.js:6`** (HIGH, fra ADMIN-REVIEW #1): fail-closed `JWT_SECRET` i prod — kast ved oppstart hvis mangler/< ~32 tegn; tilfeldig per-prosess i dev.
8. **Tester**: `tests/lib/regnskap.test.js` (mvaSplitt: 500 kr → brutto 50000 øre → netto 40000, mva 10000), `tests/lib/auth.test.js` (requireRole gater rolle, JWT sign/verify roundtrip, hash/verify). `npm test` skal være grønn.
9. Commit, push branch, åpne PR, så kjør branch protection-kommandoen nederst.
</details>

### Fase 2 — admin blir brukbar daglig  (annen terminal)
Rekkefølge: passordbytte → kalender/kapasitet → aktivitets-CRUD → kundevarsel → agenda → åpningstider.

- [ ] Admin-passordbytte fra UI
- [ ] Aktivitetskalender + kapasitet/overbookingsvern
- [ ] Aktivitets-CRUD fra adminpanel
- [ ] Kundevarsel ved statusendring (e-post + in-app)
- [ ] Booking-agenda / dagsvisning
- [ ] Åpningstider + stengte dager

### Fase 3 — komplett og robust  (annen terminal)
Observabilitet, compliance, innsikt. Verdifullt, men ikke blokkerende for drift.

- [ ] Strukturert logging + Sentry
- [ ] DB backup + DR-plan
- [ ] GDPR PII-eksport + sletting
- [ ] Refusjon/avbestilling + CSV-eksport
- [ ] Personal-livssyklus + 2FA + audit-logg
- [ ] Per-aktivitet MVA-sats (bygg på `lib/regnskap.js`)
- [ ] CRM-profil, kundesøk, analytics, CLV, RBAC-UI
- [ ] ESLint/prettier + Dependabot + CodeQL (lavkostnads-hygiene)

---

## Konkret startpunkt — branch protection (operator kjører)

`gh` er authed som Nithu0, repo er public → protection er gratis.
**Kjør først etter at `ci.yml` er pushet og `test`-jobben har kjørt minst én gang.**

```bash
gh api -X PUT repos/Nithu0/Havstund/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["test"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "dismiss_stale_reviews": true, "required_approving_review_count": 1 },
  "restrictions": null
}
JSON

# Verifiser:
gh api repos/Nithu0/Havstund/branches/main/protection \
  --jq '.required_status_checks.contexts, .required_pull_request_reviews.required_approving_review_count'
```

`enforce_admins:false` lar Nithu0 nød-merge hvis noe henger — sett `true` når flyten er stabil.

---

## Endringslogg
- 2026-06-24: Veikart opprettet (firm karri 1-8). Fase 1 startet på `fase-1-infra-sikkerhet`.
- 2026-06-24: Stoppet midt i Fase 1 for å fortsette fra annen terminal. Laget: `docs/VEIKART.md`,
  `docs/ADMIN-REVIEW.md`, `.github/workflows/ci.yml`, `lib/regnskap.js`, `lib/security.js`.
  Gjenstår: wiring-stegene over ("Resume her"). Ingen eksisterende kildekode er endret ennå —
  appen kjører uendret. Sjekk ut `fase-1-infra-sikkerhet` for å fortsette.
- 2026-06-25: Fase 1-wiring FULLFØRT (alle 9 steg koblet inn) + uavhengig verifisert av karri 5.
  Endret: `.env.example`, `.gitignore`, `package.json`(+lock), `server.js`, `lib/auth.js`,
  `routes/{bookings,auth,admin,chat}.js`; lagt til `tests/lib/{regnskap,auth}.test.js`, `vitest.config.js`.
  `npm test` = 10/10 grønn. MVA-tall bit-identiske med før. Lockfile i sync (`npm ci` virker).
  ENNÅ IKKE committet/pushet (karri 5 er lese/verifikator-rolle — operator tar git+PR+branch protection).
