# Havstund admin-side — kodegjennomgang (29 verifiserte funn)

> Firm-gjennomgang (karri 1-8) 2026-06-24. Hvert funn er verifisert mot faktisk kode (fil + linje).
> Dette er en korrekthet/UX-gjennomgang av eksisterende admin-side. Forbedrings-/utvidelsesplan
> ligger i `docs/VEIKART.md`.

## HIGH impact
| # | Tittel | Fil | Forslag |
|---|--------|-----|---------|
| 1 | Tving JWT_SECRET ved oppstart, fjern hardkodet fallback | `lib/auth.js:6` | Fjern fallback; fail-closed boot i prod hvis `JWT_SECRET` mangler/er < ~32 tegn; tilfeldig per-prosess-secret i dev |
| 2 | Verifiser rolle fra DB på privilegerte requests | `lib/auth.js:56-62` | `requireRole` gater på `req.user.rolle` fra JWT, aldri re-lest. Slå opp rolle fra `users` i autoritativ middleware for admin/regnskap (NB: `/me` gjør dette allerede) |
| 3 | Rate limiting / lockout på login | `routes/auth.js:66` | Per-IP og per-epost rate limiting + eksponentiell backoff på `/login` og `/register` |
| 4 | Status/sok-filter på booking-tabellen | `public/js/intranett.js` 192-225 | Verktøylinje: status-`<select>` (fra `STATUSER`) + fritekstsøk; filtrer klient-side |
| 5 | Omsetnings-/booking-oversikt per aktivitet og tidsrom | `routes/admin.js` 13-97 | "Kommende bookinger"-panel + topp-aktiviteter-etter-omsetning |

## MED impact
| # | Tittel | Fil | Forslag |
|---|--------|-----|---------|
| 6 | CSRF-forsvar for cookie-autentiserte admin-mutasjoner | `routes/admin.js:114` (+ bookings/meldinger) | double-submit CSRF-token, eller krev `Content-Type: application/json` + `X-Requested-With` på alle ikke-GET |
| 7 | Whitelist content-nøkler + cap verdistørrelse i CMS-upsert | `routes/admin.js:114-133` | Avvis `verdi` > ~50 KB (400); valider `nokkel` mot `^[a-z0-9_.-]{1,64}$` |
| 8 | 503 vs 500 — `db.isConfigured()`-guard på stats/content | `routes/admin.js:13` | Tidlig `if (!db.isConfigured()) return 503` i `/stats`, `/content`, PUT `/content` |
| 9 | Lokal dato (Europe/Oslo) i dag-/7d-metrikker | `routes/admin.js:19` | `CURRENT_DATE` er UTC; sammenlign `(opprettet AT TIME ZONE 'Europe/Oslo')::date` |
| 10 | Vis booking-telefon og melding i dashboardet | `public/js/intranett.js` 200-214 | `tlf`/`melding` finnes i API-svaret men vises aldri; gjør epost `mailto:`, tlf `tel:`, melding i ekspanderbar rad |
| 11 | Ulest-/ventende-badges + aktiv-seksjon i sidemenyen | `public/intranett.html` 113-121 | Gjenbruk `bookingerNye` + ulest-sum som tellebadges i nav |
| 12 | Bulk-statusendring (bekreft/avlys flere) | `public/js/intranett.js` 235-248 | Rad-checkbokser + bulk-bar; loop eksisterende PATCH |
| 13 | Suksess-feedback ved statusendring | `public/js/intranett.js` 235-248 | Speil CMS-editorens "Lagret"-mønster; inline i stedet for `alert()` |
| 14 | Skill "ingen data" fra "lasting feilet" | `public/js/intranett.js` catch 115/133/186/255 | Feiltilstand med "Prøv igjen"-knapp som re-kaller enkelt-loader |
| 15 | Mobil-overflow på booking-/meldingstabeller | `public/intranett.html` .tbl 71-77 | `overflow-x:auto`-wrapper eller stacked card-layout < 600px |
| 16 | Dirty-state + ulagret-advarsel i CMS-editoren | `public/js/intranett.js` 261-313 | input-listener → dirty-klasse; `beforeunload`-guard |

## LOW impact
| # | Tittel | Fil | Forslag |
|---|--------|-----|---------|
| 17 | Fargekode nye ('forespurt') bookinger | `public/js/intranett.js` 200-216 | Porter eksisterende `.tbl select.forespurt`-CSS fra `bookinger.html` (45-48) |
| 18 | Token-revokering / kortere admin-sesjon | `lib/auth.js:17` | Kortere TTL for ansatt/admin, eller `jti`/token-versjon på `users` for logout-all |
| 19 | Vis 7-dagers booking-serie i grafen | `public/js/intranett.js` 144-176 | `/stats` sender `bookinger` per dag; `tegnSoyler` leser kun `besok` |
| 20 | Graf dropper per-dag booking-tall API-et beregner | `public/js/intranett.js:144` | Enten render tallet (#19), eller dropp `book`-CTE i `admin.js` |
| 21 | Kunde-melding kuttes til 90 tegn uten indikator | `public/js/intranett.js:107` | Ellipsis + `title`-attributt med full (escaped) tekst |
| 22 | Stale-verdi-race i status-dropdown | `public/js/intranett.js:218` | Snapshot forrige verdi; gjenopprett in-place ved feil i stedet for full re-render |
| 23 | Cap resultatstørrelse på kunde-meldingsoversikt | `routes/meldinger.js:79-104` | LIMIT/paginering — men scope til dashboard-kallet (kunde-dialog bruker samme endpoint) |
| 24 | DB-utilgjengelig-håndtering på admin/stats | `routes/admin.js:13-96` | Duplikat av #8 — implementeres sammen |
| 25 | Booking-rad rendres med `data-id='undefined'` ved null-JOIN | `public/js/intranett.js:204` | Trim fallback-kjede til `aktivitet_navn`; ikke wire status-handler uten gyldig `b.id` |
| 26 | `/api/auth/me` respons-form gjettes på | `public/js/intranett.js:51` | Pin til faktisk kontrakt (`data.user`); dropp uneåelige fallbacks |
| 27 | `esc()` rundt `kr()`-output via innerHTML | `public/js/intranett.js:130` | `settTekst('kpiOms', kr(...))` — atferdsidentisk, enklere |
| 28 | Render-feil i dashboard-fetcher svelges stille | `public/js/intranett.js:81` | `console.error` i hver catch så render-tid-unntak blir diagnostiserbare |
| 29 | (Socket.IO-auth — utenfor admin-siden) | `realtime/chat.js` | Hvem som helst kan emulere ansatt via `ansatt_svar`; autentiser Socket.IO-events. **HIGH** i praksis — ta i Fase 1/3 sikkerhetsrunde |

## Status / kobling til veikart
- #1 (JWT_SECRET), #3 (rate limiting), #7 (CMS-whitelist) dekkes av **Fase 1** (se `docs/VEIKART.md`).
- #2 (DB-rolle), #6 (CSRF), #18 (token-revokering), #29 (Socket.IO-auth) → sikkerhetsrunde i **Fase 1/3**.
- Resten (UX/korrekthet i `intranett.js`) er en egen liten **Fase 2**-opprydding av admin-frontend.
