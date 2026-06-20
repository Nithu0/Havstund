# Havstund — plattform

Komplett nettsted + internt system for Havstund (keramikk-/kunststudio, Ballstad, Lofoten).
Node + Express + Socket.IO + PostgreSQL. Bygget for Railway.

## To ansikter, én app
- **Offentlig** (uten innlogging): forside, aktiviteter + **booking**, butikk, kontakt, **live chat 24/7** (AI svarer, ansatt kan overta).
- **Internt** (innlogging): **dashboard** (besøk, bookinger, omsetning), **chat-innboks**, innholds-redigering, og **økonomi-modell** (kun admin).

## Roller
`kunde` (booker, ser egne bookinger, chatter) · `ansatt` (+ dashboard, chat-innboks) · `admin` (+ økonomi).

## Sider
| Sti | Hva |
|---|---|
| `/` | Forside (offentlig) |
| `/aktiviteter` | Velg aktivitet + book |
| `/konto` | Logg inn / opprett konto / min side |
| `/intranett` | Dashboard (ansatt/admin) |
| `/chat-innboks` | Chat-innboks (ansatt/admin) |
| `/okonomi` | Økonomi-modell (admin) |

## Mappestruktur
```
server.js          Express + Socket.IO, auto-laster routes/ og realtime/
db/                schema.sql + tilkobling (pg) + seed (admin, aktiviteter)
lib/               auth.js (innlogging), ai.js (chat-AI)
routes/            REST: auth, activities, bookings, admin, track, chat, finance
realtime/          Socket.IO-handlere (chat)
public/            Nettsiden (HTML/CSS/JS) + bilder
KONTRAKT.md        Utviklingskontrakt (API, datamodell, roller)
```

## Kjør lokalt
```bash
npm install
# Full funksjon krever Postgres. Sett DATABASE_URL (lokal eller Railway):
#   export DATABASE_URL=postgres://bruker:pass@host:5432/havstund
npm start            # http://localhost:3000
```
Uten `DATABASE_URL` booter serveren og den **offentlige siden virker**, men booking/innlogging/chat-lagring/dashboard er av (krever database).

## Deploy på Railway
1. Push denne mappa til et Git-repo, og lag et nytt Railway-prosjekt fra repoet (Nixpacks bygger automatisk, kjører `npm start`).
2. Legg til **PostgreSQL**-plugin i samme prosjekt → Railway setter `DATABASE_URL` automatisk.
3. Sett miljøvariabler på web-tjenesten:
   - `JWT_SECRET` — en lang tilfeldig streng
   - `ADMIN_EPOST` — din admin-e-post (standard `admin@havstund.no`)
   - `ADMIN_PASSWORD` — admin-passord (standard `havstund2026` — **bytt!**)
   - `NODE_ENV=production`
4. Ved første oppstart lages skjema + seed (admin-bruker + aktiviteter) automatisk.
5. Logg inn på `/konto` med admin-kontoen → du ser dashboard, chat-innboks og økonomi.

> `railway.json` har healthcheck på `/api/health`. `PORT` settes av Railway.

## Sikkerhet / videre
- Passord hashes (bcrypt), token i httpOnly-cookie, parametriserte SQL-spørringer, egen besøksanalyse (ingen tredjepart).
- Betaling: «book nå, betal på stedet/faktura» i v1 — Vipps/kort kan kobles på senere (egen route + knapp i booking-flyten).
- Bytt `ADMIN_PASSWORD` og `JWT_SECRET` før produksjon. Bildene er foreløpig eksempelfoto (byttes med Havstunds egne).
