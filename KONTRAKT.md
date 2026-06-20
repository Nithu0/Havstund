# Havstund-plattform — utviklingskontrakt (LES FØR DU KODER)

Felles spesifikasjon. Alle moduler bygges mot denne så de passer sammen. **Ikke endre delte filer** (server.js, db/, lib/, public/css/styles.css, public/index.html, denne fila) — lag kun dine egne filer.

## Stack
Node + Express + Socket.IO + PostgreSQL (`pg`). Frontend: ren HTML/CSS/JS (ingen rammeverk), samme stil-system som `public/css/styles.css`. Kjører på Railway, lytter på `process.env.PORT`.

## Hvordan ting kobles automatisk
- **REST:** legg en fil i `routes/`. `routes/foo.js` blir montert på `/api/foo`. Filen skal `module.exports = router` (en `express.Router()`).
- **Realtime:** legg en fil i `realtime/`. Den skal `module.exports = function(io){ ... }` og kalles med Socket.IO-serveren ved oppstart.
- **Sider:** legg HTML i `public/` (serveres statisk; `/konto` -> `public/konto.html`). JS i `public/js/`. Bruk `<link rel="stylesheet" href="css/styles.css">`.

## Bruk databasen
```js
const db = require('../db');               // i routes/
const { rows } = await db.query('SELECT * FROM activities WHERE aktiv = true ORDER BY sortering', []);
const rad = await db.one('SELECT * FROM users WHERE epost=$1', [epost]); // én rad eller null
```
Bruk **parametriserte spørringer** ($1,$2…). Tabellene finnes i `db/schema.sql`.

## Bruk innlogging
```js
const { requireAuth, requireRole, signToken, setAuthCookie, hashPassword, verifyPassword } = require('../lib/auth');
router.get('/hemmelig', requireRole('ansatt','admin'), (req,res)=>{ /* req.user = {id,rolle,navn} */ });
```
`req.user` er satt globalt hvis innlogget (ellers undefined). Token ligger i httpOnly-cookie — frontend trenger bare `fetch('/api/...', { credentials:'same-origin' })`.

## Roller
- `kunde` — kan booke, se egne bookinger, chatte.
- `ansatt` — alt kunde kan + dashboard (besøk, bookinger, chat-innboks, innhold).
- `admin` — alt ansatt kan + **økonomi-modellen** (privat).
Regel: økonomi = kun `admin`. Dashboard = `ansatt`+`admin`.

## Datamodell (se db/schema.sql for felt)
users · activities · availability · bookings · chat_threads · chat_messages · pageviews · content · finance_scenarios

## API-kontrakt (hva hver modul SKAL tilby — så de andre kan bruke det)

### /api/auth  (Agent A)
- `POST /api/auth/register` {navn,epost,passord} → oppretter `kunde`, setter cookie, svarer {user:{id,navn,epost,rolle}}
- `POST /api/auth/login` {epost,passord} → setter cookie, svarer {user}
- `POST /api/auth/logout` → tømmer cookie
- `GET  /api/auth/me` → {user} eller 401

### /api/activities (Agent B)
- `GET /api/activities` → liste aktive aktiviteter [{id,slug,navn,beskrivelse,varighet,pris,kapasitet,bilde}]
- `GET /api/activities/:id` → én aktivitet

### /api/bookings (Agent B)
- `POST /api/bookings` {activity_id,navn,epost,tlf,dato,tid,antall,melding} → oppretter booking (gjest eller innlogget; sett bruker_id=req.user?.id, belop=antall*pris, status='forespurt') → {booking}
- `GET /api/bookings` → innlogget kunde: egne; ansatt/admin: alle (nyeste først), med aktivitetsnavn
- `PATCH /api/bookings/:id` {status} → kun ansatt/admin

### /api/admin (Agent C)
- `GET /api/admin/stats` (ansatt/admin) → {besokIdag,besok7d,bookingerNye,bookingerTotalt,omsetning30d, serie:[{dag,besok,bookinger}]}
- `GET /api/admin/content` / `PUT /api/admin/content/:nokkel` {verdi} (ansatt/admin)

### /api/track (Agent C)
- `POST /api/track` {sti,referrer} (åpen) → logger en pageview (anon_id fra cookie/uuid). Kalles fra alle offentlige sider.

### /api/chat (Agent D)
- `POST /api/chat/thread` {navn?,epost?} → {thread_id} (gjenbruker via cookie hvis mulig)
- `POST /api/chat/thread/:id/message` {tekst} → lagrer kundemelding, returnerer evt. AI-svar
- `GET  /api/chat/threads` (ansatt/admin) → alle tråder
- `GET  /api/chat/thread/:id/messages` → meldinger
- Realtime i `realtime/chat.js`: rom per thread; events `melding`, `ansatt_overtar`.

### /api/finance (Agent E)
- `GET /api/finance` (admin) → brukerens lagrede scenarioer
- `POST /api/finance` (admin) {navn,data} → lagre · `DELETE /api/finance/:id`

## Designsystem (klasser finnes i styles.css)
Farger via CSS-variabler: `--sea-deep, --sea, --teal, --turq, --clay, --sand, --cream, --ink`.
Komponenter: `.btn .btn-primary .btn-ghost .btn-light`, `.card`, `.price`, `.section .wrap`, `.eyebrow`, `.lead`, `.modal`, `.reveal`, `.grid .g2 .g3 .g4`.
Sidespesifikk CSS: legg i en `<style>` i din egen HTML (IKKE rør styles.css).
Tone: rolig, profesjonelt, norsk. Mobil-først.

## Frontend-mønster
- Hent data: `fetch('/api/...', {credentials:'same-origin'}).then(r=>r.json())`.
- Sjekk innlogging: `GET /api/auth/me`; redirect til `/konto` ved 401 for beskyttede sider.
- Alle offentlige sider skal inkludere chat-widgeten: `<script src="js/chat-widget.js" defer></script>` (Agent D lager den; integratoren legger den inn).

## Kvalitet
Robust feilhåndtering (try/catch, statuskoder), validér input, ingen hemmeligheter i koden, norsk i UI. Hver fil skal kunne `node --check` uten feil.
