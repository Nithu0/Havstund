# Fase 2 — Konkret design (admin blir brukbar daglig)

> Løsnings-arkitektur for Fase 2 i `docs/VEIKART.md`. Laget av karri 4 (firm8), 2026-06-25.
> Verifisert mot faktisk kode med 2 Explore-pass. Klar til at en skrive-agent bygger den.
> **Les `docs/VEIKART.md` først** for kontekst og fase-rekkefølge.

## Forutsetning (bindende rekkefølge)
- Fase 1-koden er fullført + godkjent (karri 5, 2026-06-25: 10/10 tester grønn, MVA bit-identisk, fail-closed JWT).
- **Gjenstår før Fase 2:** operator må commit → push `fase-1-infra-sikkerhet` → PR → CI grønn → **merge til `main`** → branch protection.
- Fase 2 lages som branch `fase-2-admin` **fra `main` ETTER at Fase 1 er merget** (jf. VEIKART linje 11-13, k3 rotårsak-dom). Ikke merge Fase 2 til main før Fase 1 er inne.

## Verifiserte mønstre (bruk disse — ikke gjett)
- Routes auto-mountes: `routes/<navn>.js` → `/api/<navn>` (se `server.js:33-45`).
- Auth: `requireRole('ansatt','admin')` / `requireAuth` fra `lib/auth.js`. Token `{id,rolle,navn}` i httpOnly-cookie `havstund_token`.
- Frontend: vanilla JS + `api(sti,opts)`-fetch-wrapper med `credentials:'same-origin'`. Ingen rammeverk. CSS-variabler i `public/css/styles.css`.
- Schema: idempotent `db/schema.sql` (CREATE TABLE IF NOT EXISTS), kjøres ved `db.init()` (`db/index.js:35-50`), deretter `db/seed.js`.
- Eksterne integrasjoner følger fire-and-forget + `isConfigured()`-mønster (`lib/discord.js`, `lib/fiken.js`) — kaster aldri.

---

## 6 features (byggerekkefølge)

### 1. Admin-passordbytte (S — ingen schema)
- **Ny route** i `routes/auth.js`: `POST /change-password` bak `requireAuth`. Body `{gammelt, nytt}`.
- Hent `users.passord_hash` for `req.user.id` → `verifyPassword(gammelt, hash)` (403 ved feil) → valider `nytt` mot `MIN_PASSORD_LENGTH` (env fra Fase 1, default 8) → `hashPassword(nytt)` → `UPDATE users SET passord_hash=$1 WHERE id=$2`.
- **Frontend:** pane i `public/konto.html` (eller header-modal i `min-side.html`) → `api('/api/auth/change-password',{method:'POST',body:{...}})`.
- **Test:** verifyPassword feil → 403; riktig gammelt + gyldig nytt → hash endret.

### 2. Åpningstider + stengte dager (S — kreves av #3)
- **Schema-delta** i `db/schema.sql`:
  - `business_hours(ukedag SMALLINT PRIMARY KEY, apner TIME, stenger TIME, stengt BOOLEAN DEFAULT false)` (0=man … 6=søn)
  - `closed_dates(dato DATE PRIMARY KEY, grunn TEXT)`
  - Seed 7 default-rader i `db/seed.js`.
- **Ny route** `routes/hours.js`: `GET /` (offentlig, vises på `index.html`), `PUT /:ukedag`, `POST /closed`, `DELETE /closed/:dato` (`requireRole`).

### 3. Kalender + kapasitet / overbookingsvern (M — kjerne)
- Bruk eksisterende `availability(activity_id, dato, tid, kapasitet)` (finnes, ubrukt) + `activities.kapasitet` som fallback.
- **Kapasitets-sjekk før insert** i `routes/bookings.js` POST (~linje 15), i transaksjon:
  1. Avvis hvis `closed_dates` har `dato` eller `business_hours[ukedag].stengt` → 409.
  2. `SELECT COALESCE(SUM(antall),0) FROM bookings WHERE activity_id=$1 AND dato=$2 AND tid=$3 AND status IN ('forespurt','bekreftet') FOR UPDATE` → sammenlign mot slot-kapasitet (`availability`-rad hvis finnes, ellers `activities.kapasitet`). `sum+antall > kapasitet` → 409 `{feil:'fullt'}`.
- **Admin-UI:** ny `public/availability.html` + `public/js/availability.js` (grid per aktivitet/dato). Ny `routes/availability.js`: GET (offentlig ledig-sjekk), POST/DELETE (`requireRole`).
- **Risiko:** race ved samtidige bookinger → løses av `FOR UPDATE` i transaksjonen rundt count+insert. For ett studio er det nok.

### 4. Aktivitets-CRUD fra panel (M)
- **Utvid `routes/activities.js`:** `POST /`, `PUT /:id`, `DELETE /:id` bak `requireRole('admin')`. Behold dagens GET read-only for publikum.
- **DELETE = soft-delete** → `UPDATE activities SET aktiv=false` (FK fra `bookings`/`availability`, ikke hard delete).
- **Validering:** `slug ^[a-z0-9-]{1,64}$` unik; `pris/kapasitet/varighet` heltall ≥0.
- **Frontend:** seksjon i `intranett.html` eller ny `public/aktiviteter-admin.html` + JS (tabell + rediger-modal).

### 5. Booking-agenda / dagsvisning (S)
- **Ny query** i `routes/bookings.js`: `GET /agenda?dato=` → `WHERE dato >= COALESCE($1, CURRENT_DATE) ORDER BY dato, tid` (`requireRole`).
- **Frontend:** ny `public/admin-agenda.html` + JS, dagsliste gruppert på `tid`. Ren lese-view, lav risiko.

### 6. Kundevarsel ved statusendring (M — sist, mest infra)
- **Ny `lib/email.js`** (Nodemailer; legg `nodemailer` i `package.json` deps). `sendStatusEpost(booking, nyStatus)` fire-and-forget som `lib/discord.js` (kaster aldri). SMTP via env (`SMTP_HOST/USER/PASS/FROM`); ukonfigurert → no-op + logg (`isConfigured()`-mønster fra `lib/fiken.js`).
- **In-app:** gjenbruk `customer_messages` (finnes, har `lest`-felt). Ved `PATCH /api/bookings/:id` (~linje 131) → insert `customer_messages`-rad (avsender `'admin'`) + kall `sendStatusEpost`.
- **Ulest-badge** på `min-side.html` via `GET /api/meldinger` (teller `lest=false`).
- **Risiko:** e-post eneste eksterne avhengighet → behold bak `isConfigured()` så CI/demo ikke krever SMTP.

---

## Parallellisering (4 skrive-agenter)
- **Agent A:** #1 passordbytte — `routes/auth.js` + `konto.html`.
- **Agent B:** #2 + #3 + kalender — deler `db/schema.sql` + `bookings.js` POST → hold i ÉN agent.
- **Agent C:** #4 aktivitets-CRUD — `routes/activities.js` + admin-side.
- **Agent D:** #5 + #6 — `bookings.js` PATCH + `lib/email.js` + min-side badge.

**Konfliktpunkt:** B og D rører begge `routes/bookings.js` (ulike funksjoner: B=POST ~15, D=PATCH ~131). Merge B først. `schema.sql` røres kun av B.
**Hver feature → minst 1 vitest** (gjenbruk Fase 1 vitest-oppsett) før `npm test` grønn.

## Sjekkliste før PR
- [ ] `npm test` grønn (nye tester per feature)
- [ ] `npm ci --dry-run` ok (lockfile i sync hvis nye deps lagt til — `nodemailer`)
- [ ] Ingen atferdsendring i pengelogikk (booking `belop`/MVA uendret)
- [ ] VEIKART.md Fase 2-bokser krysset av med commit-SHA
