# Forslag: Fase 4 — Fiken-adapter + refusjons-subsystem + gavekort

- Status: foreslått
- Dato: 2026-07-09
- Berører penger: JA (bokføring, utgående/inngående MVA rapportert til Skatteetaten, gjeld ved gavekort; faktisk utbetaling så snart en betalingsrail finnes)
- Reviewer: Karri
- Krever før bygging: Fiken TEST-firma-token (operatør-oppgave — se «Hva operatøren må gjøre»)
- Filer i dag: `lib/fiken.js`, `routes/regnskap.js`, `routes/bookings.js` (refusjonsruten 352–423), `db/schema.sql`

> Dette dokumentet ABSORBERER og erstatter to tidligere forslag:
> - `2026-07-09_refusjon-idempotens-atomisitet.md` (dok 1)
> - `2026-07-09_mva-inntektsspeiling.md` (dok 2)
>
> Og trekker `2026-07-09_gavekort.md` inn i scope (var «utsatt»). Se seksjon
> «Hvordan dette løser de absorberte forslagene» for hvorfor de ikke skal landes
> separat. Land IKKE dok 1 og dok 2 hver for seg — arkitekturen her løser begge
> ved kilden, og å lande dem parallelt gjenskaper akkurat interaksjons-buggen
> deres egne advarsler beskriver (to reverserende poster for samme booking).

---

## Status (foreslått)

Byggeklart designdokument for Fase 4. Ingen kode er skrevet. Money-path ⇒ går til
Karri-gjennomgang før bygging, og live-verifisering krever et Fiken-testtoken som
operatøren må skaffe.

## Bakgrunn — hva Fase 1–3 ga oss

- **Skjemafundament** (`db/schema.sql:287–323`): `dagsoppgjor` (append-only, én rad
  per dag, `lukket_tid` satt = dagen låst — men merk: låse-håndhevingen i rute-laget
  er eksplisitt utsatt til «en senere fase», `db/schema.sql:291–294`, den er IKKE
  bygget ennå), og `salgsdokument_arkiv` (PII-isolat med `bilag_ref` → Fiken
  `saleNumber`, `db/schema.sql:313–323`).
- **PII-fri, HMAC-signert pakke-generator** (`lib/regnskapspakke.js` +
  `GET /api/regnskap/pakke/:maaned`, `routes/regnskap.js:426–548`): tar en måneds
  `regnskap_poster` + `dagsoppgjor` + timer/ansatte, validerer invarianter, og
  returnerer en kanonisk serialisert, sha256-hashet, HMAC-signert pakke. Refusjoner
  bæres i dag som negative `regnskap_poster`-rader og oversettes til «handling» via
  absoluttverdi + fortegn (`lib/regnskapspakke.js:78`).
- **Fiken-adapter (skjelett)** (`lib/fiken.js`): `sendSalg`/`sendKjop` mapper en
  `regnskap_poster`-rad til Fiken `saleRequest`/`purchaseRequest` og POST-er den.
  Batch-ruta `POST /api/regnskap/fiken/send` (`routes/regnskap.js:387–417`) plukker
  alle `fiken_status='ikke_sendt'`-poster og sender dem sekvensielt.

**Tre defekter i dagens adapter/refusjon som Fase 4 må rette (alle verifisert):**

1. **`fikenId` kastes.** `lib/fiken.js:98–104` plukker faktisk `Location`-headeren og
   returnerer `{ ok:true, fikenId }`. Men kalleren `routes/regnskap.js:404` gjør kun
   `UPDATE regnskap_poster SET fiken_status='sendt' WHERE id=$1` — `resultat.fikenId`
   leses aldri, lagres aldri. Uten persistert `saleId` kan **ingenting reverseres**
   (Fiken-delete krever `saleId`). Dette er blokker nr. 1 for hele refusjons-arbeidet.

2. **`paid: true` sendes på salg.** `mapPost` (`lib/fiken.js:58–72`) legger
   `paid: true` i `felles`-objektet (linje 63), som spres til BÅDE salg (`cash_sale`,
   linje 69) og kjøp (linje 71). `paid` er IKKE en `saleRequest`-property i spec-en
   (se under). Feltet er udokumentert på salg og må fjernes derfra.

3. **Refusjon = ett felt + én negativ rad.** `routes/bookings.js:352–423`: setter
   `refund_amount_ore`/`refund_reason`/`refunded_at=now()` på bookingen (uten
   `FOR UPDATE`, uten `WHERE refunded_at IS NULL`, uten transaksjon) og INSERT-er ÉN
   negativ `regnskap_poster`-rad via en separat `db.query` pakket i en feilslukende
   `try/catch` (linje 407–409). Modellen tåler ikke flere delrefusjoner, og har ingen
   idempotens. Refusjonen sender heller ingenting til Fiken selv — den negative posten
   plukkes senere av `/fiken/send` og blir da en `cash_sale` med **negative linjer**
   (via `mapPost`), akkurat antimønsteret vi vil bort fra.

## Bekreftede Fiken-fakta (fra `api.fiken.no/api/v2` swagger v2, lest i dag)

- `PATCH /companies/{slug}/sales/{saleId}/delete?description=...` — «The sale is not
  deleted, but a reverse transaction is created and the 'deleted' property is set to
  true.» **Krever persistert `saleId`.**
- `saleResult` har feltet `deleted: boolean`.
- `GET /companies/{slug}/sales` støtter query-filtrene `saleNumber`, `settled`,
  `date`, `contactId`, `lastModified*` — **INGEN `deleted`-filter.** ⇒ et oppslag på
  `saleNumber` returnerer OGSÅ slettede salg; klienten MÅ selv lese `deleted`-feltet og
  filtrere bort `deleted:true`.
- `saleRequest` required: `date, kind, lines, currency`. Øvrige properties:
  `saleNumber, date, kind, totalPaid, totalPaidInCurrency, lines, customerId,
  currency, dueDate, kid, paymentAccount, paymentDate, paymentFee, projectId`.
  **INGEN `paid`-property.** `kind` enum: `[cash_sale, invoice, external_invoice]`.
- `orderLine.netPrice` og `vat` er `int64` (øre) UTEN `minimum`-constraint — negative
  verdier er ikke skjema-forbudt, men udokumentert. Vi bruker dem IKKE (se refusjon).

## Problem / mål

Bygg en Fiken-adapter som fører pakkens bilag inn i Fiken **reverserbart og
idempotent**, og et refusjons-subsystem som tåler N delrefusjoner per booking og
tilbyr gavekort som alternativ til pengene-tilbake. Konkret:

1. Persistér `saleId` slik at bilag kan reverseres.
2. Gjør salg spec-conformt (fjern `paid`; cash_sale bruker
   `paymentDate`+`paymentAccount`+`totalPaid`).
3. Idempotent overføring: samme bilag skal aldri postes to ganger, og en
   delete+repostér-syklus skal ikke forvirre idempotens-oppslaget.
4. Refusjons-subsystem med egen tabell, korrekt summering, invariant
   `Σ refusjoner ≤ opprinnelig`, og Fiken-flyt uten negative linjer.
5. Gavekort som regnskapsmessig forpliktelse (gjeld ved utstedelse → inntekt ved
   innløsning), med dobbeltinnløsnings-vern i samme idempotens-klasse.

---

## Idempotens-design: versjonert `saleNumber` + deleted-filter

### Hvorfor `saleNumber` alene ikke holder

Anta at bilaget for booking 42 bruker `saleNumber = "HAV-booking-42"`. Ved en
delrefusjon reverserer vi originalen (`PATCH .../{saleId}/delete`) og posterer et nytt,
redusert cash_sale. Etter dette finnes det TO salg i Fiken med samme kilde-identitet:
det gamle (nå `deleted:true`) og det nye.

Neste gang adapteren vil idempotens-sjekke — «finnes bilaget for booking 42 allerede?»
— gjør den `GET /sales?saleNumber=HAV-booking-42`. Fordi Fiken **ikke har et
deleted-filter**, returnerer dette oppslaget BÅDE det slettede og det nye salget. To
feilslutninger blir mulige:

- Uten deleted-filtrering tror adapteren at bilaget «alt finnes» og hopper over en
  legitim ny postering (del 2 av refusjonen skrives aldri), eller
- den finner det slettede salget først, tror det er det aktive, og reverserer feil
  bilag.

### Løsningen: versjonert nøkkel + eksplisitt deleted-filter

**Nøkkelformat:** `saleNumber = "HAV-booking-<bookingId>-v<n>"`, der `n` starter på 1
og økes med 1 for hver ny (redusert) postering etter en reversering. Versjonsnummeret
lagres lokalt (booking- eller refusjons-tabellen — se «Hva må bygges»), så vi alltid
vet hvilken versjon som er den nåværende aktive.

**Idempotens-oppslag (obligatorisk deleted-filter):**

```
GET /companies/{slug}/sales?saleNumber=HAV-booking-42-v2
  -> filtrer resultatet i klienten: behold kun rader med deleted === false
  -> 0 aktive rader  => bilaget mangler, det er trygt å poste v2
  -> 1 aktiv rad     => bilaget finnes allerede (og har saleId vi kan reversere)
  -> >1 aktiv rad    => datainkonsistens, avbryt + varsle (skal aldri skje)
```

Fordi hver versjon har sin egen `saleNumber`, deler det gamle (deleted) og det nye
bilaget ALDRI nøkkel. `v1` er alltid `deleted:true` etter en reversering, `v2` er den
aktive. Deleted-filteret er belte-og-seler mot at et oppslag på en gjenbrukt nøkkel
skulle returnere en slettet forgjenger.

### Flyt steg for steg (delrefusjon på et allerede-postet bilag)

1. **Les lokal tilstand** i `db.withTransaction` med `FOR UPDATE` på bookingen (lås).
   Hent nåværende `fiken_sale_id`, `fiken_sale_number` (`...-v<n>`), opprinnelig
   brutto, og `Σ` eksisterende refusjoner.
2. **Valider invariant** `Σ refusjoner + ny refusjon ≤ opprinnelig brutto`. Brudd ⇒
   400/409, ingen Fiken-kall.
3. **Idempotens-sjekk** mot Fiken på nåværende `...-v<n>` med deleted-filter. Forvent
   nøyaktig 1 aktiv rad = det bilaget vi skal reversere.
4. **Reverser originalen:** `PATCH /sales/{sale_id}/delete?description=Refusjon+<grunn>`.
   Fiken lager reverstransaksjonen og setter `deleted:true`.
5. **Postér redusert bilag** som nytt cash_sale med `saleNumber = ...-v<n+1>` og linjer
   som reflekterer det NYE netto-beløpet (opprinnelig − Σ refusjoner). **Aldri negative
   linjer** — vi poster et lavere positivt beløp, ikke en negativ korreksjon.
6. **Persistér** nytt `fiken_sale_id` + `fiken_sale_number` (`...-v<n+1>`) og
   refusjons-raden lokalt, ALT i samme transaksjon som steg 1. Feil ⇒ ROLLBACK.
7. Neste delrefusjon gjentar syklusen fra `v<n+1>` → `v<n+2>`.

Full refusjon (`Σ = opprinnelig`) er et grensetilfelle: enten postér `v<n+1>` med
0-beløp, eller la det reverserte bilaget stå uten ny postering. Anbefaling: reverser
uten ny postering, og merk booking/refusjon som fullt refundert. Avklares med
regnskapsfører (se åpne spørsmål).

---

## Refusjons-subsystem

### Datastruktur

Egen tabell — enkeltfeltet `bookings.refund_amount_ore` + én negativ rad HOLDER IKKE
for N delrefusjoner.

```sql
CREATE TABLE IF NOT EXISTS refusjoner (
  id                SERIAL PRIMARY KEY,
  booking_id        INTEGER NOT NULL REFERENCES bookings(id),
  belop_ore         INTEGER NOT NULL CHECK (belop_ore > 0),   -- alltid positivt
  grunn             TEXT,
  gavekort          BOOLEAN NOT NULL DEFAULT false,           -- true = verdi gitt som gavekort
  gavekort_id       INTEGER REFERENCES gavekort(id),          -- satt hvis gavekort valgt
  fiken_bilag_ref   TEXT,                                     -- saleNumber for det reduserte bilaget (...-v<n>)
  fiken_sale_id     TEXT,                                     -- saleId for reverstransaksjonen / nytt bilag
  idempotens_nokkel TEXT UNIQUE,                              -- én rad per refusjonshendelse
  opprettet         TIMESTAMPTZ DEFAULT now(),
  opprettet_av      TEXT
);
CREATE INDEX IF NOT EXISTS idx_refusjoner_booking ON refusjoner(booking_id);
```

`bookings.refunded_at`/`refund_amount_ore`/`refund_reason` (`db/schema.sql:261–263`)
beholdes for bakoverkompat, men er ikke lenger kilden til sannhet — summen er
`SELECT COALESCE(SUM(belop_ore),0) FROM refusjoner WHERE booking_id=$1`.

### Delrefusjon-summering + invariant

Invariant, håndhevet i applikasjonslaget INNI transaksjonen (etter `FOR UPDATE` på
bookingen):

```
Σ(refusjoner.belop_ore for booking) + ny_refusjon.belop_ore  ≤  opprinnelig_brutto_ore
```

Brudd ⇒ 409 med tydelig melding («Refusjonsbeløpet overstiger gjenstående»). Fordi
bookingen er låst med `FOR UPDATE`, kan to samtidige delrefusjoner ikke begge lese en
utdatert sum og begge passere sjekken — den andre blokkerer til den første committer,
og ser da den oppdaterte summen. `idempotens_nokkel UNIQUE` er database-belte mot at
samme refusjonshendelse (samme klientforespørsel, retry/dobbelklikk) skrives to ganger.

Erstatter den partielle unique-indexen fra dok 1
(`uniq_refusjonspost_per_booking … WHERE netto_ore < 0`): den indexen håndhevet «maks
én refusjon per booking», som er i direkte konflikt med N delrefusjoner. Den skal IKKE
opprettes. Idempotensen flyttes fra «én negativ post» til «unik idempotens-nøkkel per
hendelse».

### Fiken-flyt

Per delrefusjon: **delete original + repostér redusert cash_sale med ny versjon**
(stegene 4–6 over). ALDRI negative linjer. Beløpet i det nye bilaget er alltid det
gjenstående positive netto etter alle refusjoner så langt.

### Kvittering + gavekort-valg

Hver refusjon lager en kvittering (kvitterings-generering gjenbruker eksisterende
e-post/kvitterings-infra — `lib/email.js`, `routes/receipts.js`; kobling verifiseres
ved bygging). Ved refusjon velger kunden/operatøren:

- **Penger tilbake:** refusjons-verdien går ut som utbetaling (når en betalingsrail
  finnes; i DEMO i dag kun regnskapsført). `gavekort=false`.
- **Gavekort:** i stedet for utbetaling utstedes et gavekort av samme verdi.
  `gavekort=true`, `gavekort_id` peker på den nye gavekort-raden. Regnskapsmessig
  flyttes verdien da fra salgsinntekt (reversert) til gavekort-gjeld — ikke ut som
  penger. Se gavekort-seksjonen.

---

## Gavekort

### Datamodell

```sql
CREATE TABLE IF NOT EXISTS gavekort (
  id            SERIAL PRIMARY KEY,
  kode          TEXT NOT NULL UNIQUE,               -- unik innløsningskode
  belop_ore     INTEGER NOT NULL CHECK (belop_ore > 0),  -- utstedt verdi
  saldo_ore     INTEGER NOT NULL,                   -- gjenstående (start = belop_ore)
  status        TEXT NOT NULL DEFAULT 'aktiv',      -- aktiv | innlost | utlopt | annullert
  kilde         TEXT,                               -- 'refusjon' | 'salg' | ...
  refusjon_id   INTEGER REFERENCES refusjoner(id),  -- hvis utstedt fra en refusjon
  utlopsdato    DATE,                               -- juridisk policy — se åpne spm
  opprettet     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gavekort_transaksjoner (
  id                SERIAL PRIMARY KEY,
  gavekort_id       INTEGER NOT NULL REFERENCES gavekort(id),
  belop_ore         INTEGER NOT NULL,               -- trukket (innløsning) el. tilført
  booking_id        INTEGER REFERENCES bookings(id),-- hva gavekortet ble brukt på
  idempotens_nokkel TEXT UNIQUE,                    -- én rad per innløsningshendelse
  opprettet         TIMESTAMPTZ DEFAULT now()
);
```

`saldo_ore` støtter delvis innløsning. `gavekort_transaksjoner` er hovedboka;
`saldo_ore` er den låste, verifiserbare cachen (invariant:
`saldo_ore = belop_ore − Σ trukne transaksjoner`).

### Regnskapsmessig behandling

Et gavekort er en **forpliktelse (gjeld)**, ikke inntekt ved utstedelse:

- **Ved utstedelse** (også når det utstedes fra en refusjon): bokfør verdien på en
  gjeldskonto for uinnløste gavekort. Ingen inntekt, ingen utgående MVA ennå. Når
  gavekortet kommer fra en refusjon, er nettoeffekten: reverser den opprinnelige
  salgsinntekten (delete+repostér, som for penger-tilbake) OG opprett gavekort-gjeld —
  pengene forlater ikke firmaet, de bytter regnskapsmessig fra «opptjent salg» til
  «skyldig tjeneste».
- **Ved innløsning:** flytt beløpet fra gavekort-gjeld til salgsinntekt med korrekt
  MVA-behandling (MVA-tidspunktet avklares med regnskapsfører — utstedelse vs.
  innløsning).

Konkret gjeldskonto avklares med regnskapsfører (åpent spørsmål).

### Dobbeltinnløsnings-vern (samme idempotens-klasse som Fiken-oppslaget)

Innløsning kjøres i `db.withTransaction` med `SELECT ... FOR UPDATE` på gavekort-raden
(mønster: booking-opprettelsen, `routes/bookings.js:124–126`):

1. Lås gavekort-raden (`FOR UPDATE`).
2. Sjekk `status='aktiv'`, `utlopsdato >= i dag`, `saldo_ore >= ønsket beløp`.
3. Trekk fra `saldo_ore`, sett `status='innlost'` hvis 0.
4. Skriv `gavekort_transaksjoner`-rad med `idempotens_nokkel UNIQUE`.
5. Alt committer eller ruller tilbake sammen.

To samtidige innløsninger av samme kode kan da ikke begge passere saldosjekken —
raden er låst, den andre ser oppdatert saldo. `idempotens_nokkel UNIQUE` fanger
retry/dobbelklikk på database-nivå (samme prinsipp som deleted-filteret gjør for
Fiken: aldri stol på et les-så-skriv uten et unikhets-/lås-vern).

### Åpne juridiske spørsmål (operatøren avklarer)

- Lovlig utløpstid for gavekort i denne bransjen (norsk forbrukerlovgivning +
  foreldelsesregler for pengekrav). Må avklares FØR første gavekort utstedes — ellers
  bygger vi inn et lovbrudd. `utlopsdato` er nullbar til policyen er satt.
- Om et refusjons-gavekort juridisk kan ha kortere/annen gyldighet enn et solgt.

---

## Spec-conformance-fiks

1. **Fjern `paid` fra salg-payload.** I `mapPost` (`lib/fiken.js:58–72`): `paid` skal
   ikke lenger ligge i `felles`. For `cash_sale` bygg payloaden av spec-feltene:
   `date, kind:'cash_sale', currency, lines, saleNumber, totalPaid, paymentAccount,
   paymentDate` (betalt kontantsalg uttrykkes via `paymentDate`+`paymentAccount`+
   `totalPaid`, ikke via et `paid`-flagg).
2. **Persistér `fikenId`/`saleId`.** `lib/fiken.js:98–104` returnerer allerede
   `fikenId`. Kalleren `routes/regnskap.js:404` må lagre den:
   `UPDATE regnskap_poster SET fiken_status='sendt', fiken_sale_id=$2 WHERE id=$1`
   (ny kolonne, se «Hva må bygges»). Uten dette er ingenting reverserbart.
3. **Behold `paid` KUN på kjøp.** ANTAGELSE (ikke verifisert — se rapport): operatøren
   oppgav kun `saleRequest`-spec, ikke `purchaseRequest`. Dagens kode sender
   `kind:'cash_purchase'` (`lib/fiken.js:71`) til `/purchases`, som er et annet
   skjema (`purchaseRequest`) med egen `kind`-enum. Det er sannsynlig at
   `purchaseRequest` HAR `paid` (kontantkjøp markeres betalt), men dette må verifiseres
   mot `purchaseRequest`-definisjonen i spec-en før `paid` fjernes fra kjøps-grenen.
   Til det er verifisert: la kjøps-payloaden være uendret.

---

## Hvordan dette løser de absorberte forslagene

- **Dok 1 (refusjons-idempotens/atomisitet):** løst og utvidet. `refusjoner`-tabellen +
  `FOR UPDATE` på bookingen + `idempotens_nokkel UNIQUE` + hele operasjonen i én
  `db.withTransaction` gir samme atomisitet/idempotens dok 1 ba om — men støtter N
  delrefusjoner i stedet for dok 1s «én per booking». Dok 1s partielle unique-index
  (`WHERE netto_ore < 0`) forkastes; den var i konflikt med delrefusjoner.
- **Dok 2 (MVA-inntektsspeiling):** løst ved kilden. Dobbeltrefusjon dør fordi
  refusjon nå går gjennom delete+repostér mot et persistert `saleId` med
  invariant-summering — det finnes ingen vei til to uavhengige reverserende poster.
  Videre: **dagslukking gjør retro-refusjon umulig** — når `dagsoppgjor`-låsen
  håndheves (`lukket_tid` satt ⇒ dagen låst, `db/schema.sql:291`), kan ikke en
  refusjon skrive om en lukket dags historikk; en refusjon etter dagslukking må
  postere i inneværende (åpne) dag som en egen hendelse. Det lukker vinduet der to
  reverseringer for samme dag kunne stables. **MERK:** låse-håndhevingen i rute-laget
  er IKKE bygget ennå (kun tabell-kommentar). Denne garantien forutsetter at Fase 4
  også bygger dagsluknings-håndhevingen (eller at det tas som eget punkt) — se åpne
  spørsmål.

Dok 1 og dok 2 skal derfor markeres «erstattet av
`2026-07-09_fase4-fiken-refusjon-gavekort.md`» og ikke landes hver for seg.

---

## Hva må bygges (byggeklart)

**Schema (`db/schema.sql`, idempotent, samme mønster som eksisterende migreringer):**

- `ALTER TABLE regnskap_poster ADD COLUMN IF NOT EXISTS fiken_sale_id TEXT;`
- `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fiken_sale_id TEXT;`
- `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fiken_sale_number TEXT;`
  (nåværende versjon `...-v<n>`)
- `CREATE TABLE IF NOT EXISTS refusjoner (...)` (se over).
- `CREATE TABLE IF NOT EXISTS gavekort (...)` + `gavekort_transaksjoner (...)`.
- Ev. dagsluknings-håndheving (hvis tatt i denne fasen).

**`lib/fiken.js`:**

- Fjern `paid` fra salg (spec-fiks 1); bygg `cash_sale` av spec-felter + `saleNumber`.
- Ny `reverserSalg(saleId, beskrivelse)` → `PATCH /sales/{saleId}/delete?description=`.
- Ny `finnAktivtSalg(saleNumber)` → `GET /sales?saleNumber=...` + **klient-side
  filter `deleted === false`**; returner `{ finnes, saleId }`.
- La kjøps-grenen stå til `purchaseRequest.paid` er verifisert.

**`routes/regnskap.js`:**

- Persistér `fiken_sale_id` ved vellykket send (spec-fiks 2, linje 404).

**`routes/bookings.js` (refusjonsruten 352–423) — MERK: en annen agent redigerer
denne filen nå; dette forslaget rører den ikke, kun spesifiserer):**

- Erstatt enkelt-felt-refusjonen med: `db.withTransaction` → `FOR UPDATE` på booking →
  `Σ refusjoner`-invariant → Fiken delete+repostér (versjonert `saleNumber` +
  deleted-filter) → INSERT i `refusjoner` med `idempotens_nokkel` → oppdater
  `fiken_sale_number`/`fiken_sale_id` → kvittering. Feil ⇒ ROLLBACK + non-200.
- Gavekort-valg: hvis `gavekort=true`, opprett gavekort-rad i samme tx i stedet for
  utbetalings-sti.

**Ny gavekort-rute (`routes/gavekort.js` e.l.):** utstedelse (fra refusjon eller salg)
+ innløsning (`FOR UPDATE`, saldo, idempotens) + saldo-oppslag. Bak feature-flag,
default OFF.

## Test-plan

**Enhet/integrasjon (`tests/`, gjenbruk stub-mønster fra `tests/routes/bookings.test.js`):**

1. `mapPost` for salg inneholder IKKE `paid`, og HAR `saleNumber`+`paymentDate`+
   `paymentAccount`+`totalPaid`.
2. `finnAktivtSalg` filtrerer bort `deleted:true` (gitt et mock-svar med både slettet
   `-v1` og aktiv `-v2`, returner kun `-v2`s `saleId`).
3. Delrefusjon x N: tre refusjoner på samme booking summerer korrekt; fjerde som
   sprenger `Σ ≤ opprinnelig` gir 409.
4. Idempotens: samme `idempotens_nokkel` to ganger ⇒ én `refusjoner`-rad (unique
   fanger den andre).
5. Atomisitet: mock at Fiken-repostér kaster ⇒ ROLLBACK, ingen `refusjoner`-rad,
   booking-sum uendret.
6. Gavekort-innløsning: to samtidige innløsninger trekker kun én gang; utløpt gavekort
   avvises; delvis saldo fungerer.
7. Regnskap: gavekort-utstedelse treffer gjeldskonto (ikke inntekt); innløsning flytter
   til inntekt.

**Umockbar del — live-probe mot Fiken TEST-firma (krever operatør-token).** Spec er
lest, men følgende MÅ bekreftes live, fordi de avhenger av faktisk API-atferd, ikke
bare skjema:

- At `PATCH /sales/{saleId}/delete?description=...` returnerer 200 og at et
  påfølgende `GET /sales?saleNumber=...-v1` viser `deleted:true` på originalen.
- At `GET /sales?saleNumber=...` FAKTISK returnerer slettede salg (spec sier ingen
  deleted-filter — bekreft at et slettet salg dukker opp, ellers er filteret vårt
  unødvendig men harmløst).
- At et repostet `cash_sale` med `paymentDate`+`paymentAccount`+`totalPaid` (uten
  `paid`) aksepteres (201 + `Location`-header med `saleId`).
- At `saleNumber` kan gjenbrukes med suffiks `-v2` uten kollisjon mot det slettede
  `-v1` (om Fiken håndhever unik `saleNumber`, må versjons-strategien evt. justeres).
- Rate limit-atferd ved sekvensiell delete+repost (dagens batch antar ~1 req/s,
  `routes/regnskap.js:398`).
- `purchaseRequest.paid` — verifiser om feltet finnes (avgjør spec-fiks 3).

## Risiko + rollback

- **Risiko:** høy — dette er den mest penge-nære endringen i katalogen (bokføring,
  MVA, gjeld, reversering mot ekstern regnskaps-API). Gavekort er en reell forpliktelse
  som ikke kan «rulles tilbake» når et kort først er utstedt.
- **Rollback:** all Fiken-adferd bak `isConfigured()`-gaten (ingen token ⇒
  `{ simulert:true }`, `lib/fiken.js:112,119`) — adapteren er inert uten env. Gavekort
  og ny refusjonssti bak feature-flag, default OFF. Ren revert gjenoppretter dagens
  oppførsel; nye tabeller/kolonner er additive (`IF NOT EXISTS`), ingen destruktiv
  migrering.
- **Skatterelevant:** MVA-tidspunkt (gavekort utstedelse vs. innløsning) og
  gjeldskonto må gjennom regnskapsfører før land.

## Hva operatøren må gjøre

1. **Skaff Fiken TEST-firma-token** (`FIKEN_API_TOKEN` + `FIKEN_COMPANY_SLUG` for et
   test-selskap) — uten dette kan den umockbare live-proben ikke kjøres, og adapteren
   kan ikke penge-verifiseres.
2. **Juridisk gavekort-avklaring:** lovlig utløpstid (norsk forbrukerlov +
   foreldelse), før første gavekort utstedes.
3. **Regnskapsfører-avklaring:** gjeldskonto for uinnløste gavekort + MVA-tidspunkt
   (utstedelse vs. innløsning) + behandling av full vs. delvis refusjon.
4. **EØS/region:** bekreft at Fiken-kall og eventuell datalagring holder seg innen EØS
   (relevant ved valg av hosting/region for adapteren).
5. **Godkjenne** at refusjon nå kan gi 409 (invariant-brudd / allerede fullt refundert)
   og at admin-UI viser det forståelig.

## Åpne spørsmål

1. Full refusjon: postér `-v<n+1>` med 0-beløp, eller reverser uten ny postering?
   (Regnskapsfører.)
2. Håndhever Fiken unik `saleNumber` per firma? Hvis ja, er `-v<n>`-suffikset
   nødvendig OG tilstrekkelig; hvis salg med samme number avvises må vi bekrefte at
   det gjelder også når forgjengeren er `deleted:true`. (Live-probe.)
3. `purchaseRequest.paid` — finnes feltet? (Spec-verifisering, avgjør spec-fiks 3.)
4. Skal dagsluknings-håndhevingen (`dagsoppgjor.lukket_tid`) bygges i Fase 4 eller som
   eget punkt? Dok 2-garantien («dagslukking gjør retro-refusjon umulig») forutsetter
   at den finnes — i dag gjør den ikke det (`db/schema.sql:291`).
5. MVA ved gavekort-innløsning: én sats, eller aktivitetens sats på innløsnings-
   tidspunktet? (Regnskapsfører.)
6. Betalingsrail: penger-tilbake-grenen forutsetter en utbetalings-rail som ikke finnes
   i repoet i dag (jf. det tidligere Vipps-forslaget). Til den lander er «penger
   tilbake» kun regnskapsført, ikke faktisk utbetalt — bekreft at det er akseptabelt i
   DEMO.
