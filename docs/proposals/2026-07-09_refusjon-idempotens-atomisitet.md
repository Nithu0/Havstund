# Forslag: Refusjon — idempotens + atomisitet

- Status: foreslått
- Dato: 2026-07-09
- Berører penger: JA (regnskap/MVA i dag; faktisk utbetaling så snart en betalingsrail finnes)
- Reviewer: Karri
- Filer i dag: `routes/bookings.js` (refusjonsruten, linje 303–374)

> ADVARSEL — LAND DENNE ALENE, FØRST.
> En tidligere review fant en interaksjons-bug da denne fiksen ble bygget SAMMEN
> med MVA-reverseringen (forslag `2026-07-09_mva-inntektsspeiling.md`, dok 2). Begge
> rører `regnskap_poster` for samme booking og begge legger reverserende poster.
> Bygges de i samme PR, blir det uklart hvilken post som eier hvilken reversering,
> og en delvis feil i den ene kan skjule den andre. Anbefaling: land denne
> (idempotens/atomisitet på refusjon) helt ferdig og verifisert FØR dok 2 påbegynnes.

---

## Problem (med fil:linje-bevis)

Refusjonsruten `POST /:id/refusjon` i `routes/bookings.js:303–374` gjør tre separate
DB-operasjoner uten felles transaksjon og uten idempotens-vern:

1. `routes/bookings.js:314` — leser bookingen:
   ```
   const booking = await db.one('SELECT * FROM bookings WHERE id = $1', [id]);
   ```
   Ingen `FOR UPDATE`. Raden er ikke låst.

2. `routes/bookings.js:325–331` — markerer refundert:
   ```
   UPDATE bookings
      SET refund_amount_ore = $1, refund_reason = $2, refunded_at = now()
    WHERE id = $3
   ```
   Ingen `WHERE refunded_at IS NULL`. Ruten sjekker ingensteds om `refunded_at`
   allerede er satt. En andre refusjon overskriver bare den første.

3. `routes/bookings.js:342–357` — reverserende (negativ) regnskapspost:
   ```
   await db.query(`INSERT INTO regnskap_poster (...) VALUES ('inntekt', ...)`, [...])
   ```
   Denne kjøres via `db.query` (egen connection fra poolen), altså UTENFOR enhver
   transaksjon, og er pakket i en `try/catch` som svelger feilen:
   `routes/bookings.js:358–360`:
   ```
   } catch (regnskapFeil) {
     console.error('bookings: kunne ikke lagre refusjonspost:', regnskapFeil.message);
   }
   ```
   Feiler INSERT-en, svarer ruten fortsatt 200 og bookingen står markert som
   refundert uten matchende reverserende post.

Til sammenligning: booking-opprettelsen gjør dette riktig. `routes/bookings.js:84`
kjører hele kapasitetssjekk + booking-INSERT + regnskap-INSERT i én
`db.withTransaction(...)`, med `SELECT ... FOR UPDATE` som serialiseringslås
(`routes/bookings.js:86`) og en idempotens-lookup mot `regnskap_poster` før
inntektsposten skrives (`routes/bookings.js:128–132`). Refusjonsruten har ingen av
disse vernene.

Merk også: idempotens-lookupen på linje 128–132 gjelder KUN inntektsposten ved
booking-opprettelse. Det finnes ingen tilsvarende sjekk for refusjonsposten — hver
refusjonsklikk lager en ny negativ post.

## Konsekvens

To samtidige klikk (eller to utålmodige klikk, eller en dobbel-submit) på samme
booking kan begge passere `SELECT`-en, begge kjøre `UPDATE`-en, og begge kjøre den
negative INSERT-en. Resultat:

- I dag (ingen betalingsrail i repoet — se dok 3): to negative poster i
  `regnskap_poster` for samme booking. Omsetning og utgående MVA blir dobbelt
  nedjustert. Det er en reell feilrapportering til Skatteetaten — under-rapportert
  omsetning/MVA — selv uten at det flyttes kontanter.
- Når en betalingsrail lander (Vipps-depositum, dok 3): to faktiske utbetalinger.
  Da blir dette tap av ekte penger.

Dette er den eneste gjenstående defekten i bookings-stien som allerede har
penge-/skattekonsekvens i dag. Å bygge innbetaling (dok 3) oppå en ikke-idempotent
refusjonssti multipliserer risikoen — derfor må denne lukkes først.

## Foreslått løsning

Speil mønsteret fra POST-booking (`routes/bookings.js:84`). Pakk hele refusjonen i
én `db.withTransaction(async (client) => { ... })` og bruk `client` for alle spørringer:

1. `SELECT * FROM bookings WHERE id = $1 FOR UPDATE` — låser booking-raden for
   transaksjonens levetid, så en samtidig refusjon blokkerer til vi committer.
2. Hvis `booking.refunded_at IS NOT NULL` (raden er allerede refundert): avbryt med
   HTTP 409 (Conflict) og en tydelig melding. Ingen andre UPDATE, ingen ny post.
   409 er samme kode ruten allerede bruker for kapasitets-/stengt-konflikter
   (`routes/bookings.js:60,69,161`), så klienten kjenner mønsteret.
3. `UPDATE bookings SET refund_amount_ore=..., refund_reason=..., refunded_at=now()
   WHERE id=$id AND refunded_at IS NULL` — belte-og-bukseseler: WHERE-klausulen gjør
   at en andre skriver treffer 0 rader selv om steg 2 skulle svikte.
4. Den reverserende `regnskap_poster`-INSERT-en flyttes INN i samme transaksjon,
   via samme `client`. Booking-markering og reverserende post committer eller
   ruller tilbake SAMMEN.
5. Ikke svelg feilen. La en feil i INSERT-en propagere ut av transaksjons-callbacken
   slik at `withTransaction` ROLLBACK-er alt og ruten svarer 500 (samme atomisitets-
   kontrakt som booking-opprettelsen, jf. `routes/bookings.js:121–127`).

`writeAudit`-kallet (`routes/bookings.js:363`) beholdes ETTER commit — revisjonssporet
skal bare skrives når refusjonen faktisk gikk gjennom.

### Database-nivå-vern (partial unique index)

Applikasjonssjekken over er primærvernet. Som ekstra lag, i tilfelle en fremtidig
kodesti (eller manuell SQL) omgår ruten, legg en partial unique index som håndhever
maks én reverserende post per booking:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uniq_refusjonspost_per_booking
  ON regnskap_poster (booking_id)
  WHERE kilde = 'booking' AND netto_ore < 0;
```

Negativ `netto_ore` er signaturen til en refusjonspost (`routes/bookings.js:352`).
Indexen tvinger databasen til å avvise en andre negativ booking-post for samme
booking — den samtidige transaksjonen som taper kappløpet får en unique-violation og
ROLLBACK-er.

VIKTIG BEGRENSNING (åpent spørsmål): ruten støtter i dag DELVIS refusjon via
`belop_ore` (`routes/bookings.js:311,319`). Dagens design tillater likevel bare ÉN
refusjon per booking (etter fiksen blokkerer `refunded_at IS NOT NULL` alle senere
refusjoner, delvis eller full). Den partielle indexen over er konsistent med det:
én negativ post per booking. Vil eieren senere ha FLERE delvise refusjoner på samme
booking, må BÅDE applikasjonssjekken (`refunded_at`) og denne indexen redesignes
(f.eks. en egen `refusjoner`-tabell med eget idempotens-nøkkel per refusjonshendelse).
Det bør avklares før implementasjon, men er ikke nødvendig for å lukke defekten.

## Alternativer vurdert

- Kun `refunded_at IS NULL` i WHERE, uten transaksjon/lås. Forkastet: lukker
  dobbel-UPDATE, men den negative posten kan fortsatt dobles hvis begge kall leser
  før noen skriver, og posten ligger uansett utenfor tx. Halv fiks.
- Kun DB-index, ingen applikasjonsendring. Forkastet: gir en rå 500 (unique
  violation) i stedet for en ren 409, og lar booking-UPDATE kjøre selv når posten
  avvises — inkonsistent tilstand. Index skal være belte, ikke bukse.
- Advisory lock (`pg_advisory_xact_lock`). Forkastet som unødvendig: rad-lås via
  `FOR UPDATE` på booking-raden er enklere, mer lokal, og speiler eksisterende
  mønster i repoet.

## Risiko + rollback

- Risiko: lav. Endringen er lokal til refusjonsruten. Ingen endring i booking-
  opprettelse, status-PATCH eller lesestier.
- Nytt utfall for klienten: 409 ved dobbel refusjon (før: stille 200 med
  overskriving). Admin-UI som antar 200 må tåle 409 — sjekk kallstedet i frontend
  før land (åpent spørsmål under).
- Rollback: ren revert av PR-en gjenoppretter dagens oppførsel umiddelbart.
  Den partielle unique-indexen droppes med `DROP INDEX uniq_refusjonspost_per_booking;`
  — men bør beholdes selv om koden reverteres, siden den er et rent vern.
  Legg til med `CREATE UNIQUE INDEX IF NOT EXISTS` i `db/schema.sql` (idempotent,
  samme mønster som eksisterende migreringer, jf. `db/schema.sql:243–245`).

## Test-plan

Eksisterende test `tests/routes/bookings.test.js:288–301` dekker at refusjon lager
én negativ post. Utvid samme fil (stubber `db.withTransaction` allerede — se
`tests/routes/bookings.test.js:78–111` — så refusjonen kan gå gjennom tx-klienten):

1. Første refusjon på en booking uten `refunded_at`: 200, én negativ post, booking
   får `refunded_at` satt.
2. Andre refusjon på samme (nå refunderte) booking: 409, INGEN ny post, INGEN ny
   UPDATE. Assert at `state.regnskap` fortsatt har lengde 1.
3. Atomisitet: simuler at den negative INSERT-en kaster (samme mønster som
   `state.regnskapFeiler`, `tests/routes/bookings.test.js:88–92`). Forvent 500 og
   at booking IKKE står markert refundert (ruller tilbake sammen).
4. Verifiser at alle refusjons-spørringer går via tx-klienten, ikke `db.query`
   (speil `state.regnskapViaTx`-sjekken, `tests/routes/bookings.test.js:199–200`).

Manuell verifikasjon mot ekte Postgres (staging): to parallelle `curl`
POST /:id/refusjon mot samme booking, forvent nøyaktig én negativ post i
`regnskap_poster` og at det andre kallet får 409.

## Hva eieren må gjøre

- Godkjenne at 409-utfallet er ønsket ved dobbelklikk (i stedet for stille 200).
- Bekrefte designvalget: én refusjon per booking (nåværende) vs. fremtidig behov for
  flere delvise refusjoner. Dette avgjør om den partielle indexen holder.
- Sørge for at admin-frontend som kaller refusjonsknappen viser 409 som en
  forståelig melding ("Allerede refundert"), ikke som en generisk feil.

## Åpne spørsmål

1. Skal delvis refusjon (`belop_ore`) beholdes som mulighet i det hele tatt, eller
   er alle refusjoner i praksis fulle? Svaret avgjør index-designet.
2. Finnes det allerede dobbeltbokførte refusjonsposter i produksjons-databasen
   (fra før fiksen)? I så fall trengs en engangs-opprydding (kreditnota-logikk, ikke
   sletting — samme prinsipp som dok 2). Bør sjekkes med en `SELECT booking_id,
   count(*) FROM regnskap_poster WHERE kilde='booking' AND netto_ore < 0 GROUP BY
   booking_id HAVING count(*) > 1` før indexen legges (ellers feiler
   index-opprettelsen på eksisterende duplikater).
3. Frontend-kallstedet for refusjonsknappen — finnes retry/dobbelklikk-vern der i
   dag, eller er backend eneste forsvar?
