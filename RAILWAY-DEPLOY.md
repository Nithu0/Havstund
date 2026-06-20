# Railway-deploy: Havstund-plattform — oppdrag til deploy-agent

Du skal deploye en **ferdig Node-applikasjon** til Railway. Koden er komplett i dette repoet (rotmappe = denne mappa, der `package.json` og `server.js` ligger). Du skal **ikke skrive om appen** — bare deploye den, koble til en database og sette miljøvariabler, og verifisere at den kjører.

---

## 1. Hva appen er
Havstund er et keramikk-/kunststudio. Dette er én Node-app (Express + Socket.IO) som serverer både en offentlig nettside (booking + live chat) og et internt dashboard (innlogging, besøk/bookinger, økonomi). Den bruker PostgreSQL.

## 2. Stack / kjøring (allerede konfigurert i repoet)
- **Runtime:** Node.js ≥ 18 (`engines.node` i `package.json`). Bruk Nixpacks (auto-deteksjon av Node).
- **Install:** `npm install` (Nixpacks kjører dette automatisk).
- **Start:** `npm start` (= `node server.js`). Definert i `package.json` og `railway.json`.
- **Port:** appen lytter på `process.env.PORT`. **Ikke hardkod port** — Railway injiserer den.
- **Healthcheck:** `GET /api/health` → `{ "ok": true, "db": true }` når DB er koblet. (Står i `railway.json`.)
- **Databaseoppsett:** appen kjører selv `db/schema.sql` + seeding (admin-bruker + aktiviteter) ved første oppstart. **Ingen manuelle migrasjoner trengs.**

## 3. Tjenester som skal opprettes i Railway-prosjektet
1. **Web-tjeneste** fra dette Git-repoet (root = denne mappa).
2. **PostgreSQL**-plugin i samme prosjekt.

## 4. Miljøvariabler (settes på web-tjenesten)
| Variabel | Verdi | Merknad |
|---|---|---|
| `DATABASE_URL` | Postgres-tilkoblingsstreng | Settes vanligvis automatisk når Postgres-pluginen er i samme prosjekt. Hvis ikke: referer til Postgres-tjenesten, f.eks. `${{Postgres.DATABASE_URL}}`. **Påkrevd.** |
| `JWT_SECRET` | en lang, tilfeldig streng | For innlogging (sesjons-token). **Påkrevd i prod.** |
| `ADMIN_EPOST` | `admin@havstund.no` | Admin-bruker som lages ved første oppstart. |
| `ADMIN_PASSWORD` | et sterkt passord | Admin-passord. **Sett et eget — ikke standardverdien.** |
| `NODE_ENV` | `production` | Sikrer bl.a. secure cookies. |

> Appen håndterer selvsignert SSL på managed Postgres automatisk. Kun hvis du får SSL-feil: sett `PGSSL=disable`.

## 5. Deploy-steg
1. Opprett Railway-prosjekt fra dette Git-repoet (Nixpacks-builder).
2. Legg til **PostgreSQL**-plugin i prosjektet.
3. Sett miljøvariablene i tabellen over på web-tjenesten.
4. Sørg for at `DATABASE_URL` på web-tjenesten peker til Postgres-tjenesten.
5. Deploy. Generér en **public domain** for web-tjenesten.

## 6. Verifiser at deployen er vellykket
Etter deploy, sjekk i denne rekkefølgen:
1. `GET https://<domenet>/api/health` → skal gi `{"ok":true,"db":true}`. Hvis `"db":false` → `DATABASE_URL` er ikke koblet riktig.
2. Åpne `https://<domenet>/` → forsiden lastes.
3. Åpne `https://<domenet>/aktiviteter` → en liste med aktiviteter vises (kommer fra databasen → bekrefter at skjema + seed kjørte).
4. Åpne `https://<domenet>/konto` → logg inn med `ADMIN_EPOST` / `ADMIN_PASSWORD`.
5. Etter innlogging: `https://<domenet>/intranett` skal vise dashboardet (KPI-er), og `https://<domenet>/okonomi` skal være tilgjengelig (admin).
6. Chat-boblen nederst til høyre på offentlige sider skal svare automatisk (AI).

## 7. Feilsøking
- **`db:false` i health** → `DATABASE_URL` mangler/feil. Koble web-tjenesten til Postgres-variabelen og redeploy.
- **Aktiviteter/booking tomt eller 503** → databasen er ikke nådd; samme årsak som over.
- **Krasjer ved oppstart** → sjekk loggen; vanligst er manglende `DATABASE_URL` eller feil Node-versjon (skal være ≥18).
- **Redeploy etter endring:** bruk «Deploy latest» (en per-rad «Redeploy» gjenbygger samme snapshot).

## 8. Hva du IKKE skal gjøre
- Ikke endre applikasjonskoden (`server.js`, `routes/`, `public/` osv.).
- Ikke kjøre manuelle SQL-migrasjoner — appen gjør det selv.
- Ikke hardkode port eller hemmeligheter i koden — bruk miljøvariabler.

**Mål:** en kjørende public URL der `/api/health` gir `{"ok":true,"db":true}` og man kan booke en aktivitet og logge inn som admin.
