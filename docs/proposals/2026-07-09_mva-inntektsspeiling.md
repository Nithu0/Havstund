# Forslag: MVA — inntektsspeiling ved feil bookingstatus

- Status: foreslått
- Dato: 2026-07-09
- Berører penger: JA (utgående MVA / rapportert omsetning til Skatteetaten)
- Reviewer: Karri
- Filer i dag: `routes/bookings.js` (booking-opprettelse 112–158; status-PATCH 253–299)

> Rekkefølge: land forslag `2026-07-09_refusjon-idempotens-atomisitet.md` (dok 1)
> FØRST. En tidligere review fant en interaksjons-bug da denne MVA-reverseringen ble
> bygget sammen med refusjons-idempotensen. Begge legger reverserende poster i
> `regnskap_poster` for samme booking. Hold dem i separate PR-er.

---

## Problem (med fil:linje-bevis)

Inntekt speiles til `regnskap_poster` allerede når en booking OPPRETTES, og
bookinger opprettes alltid med status `forespurt`:

- `routes/bookings.js:115` — INSERT-en setter status hardkodet til `'forespurt'`:
  ```
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'forespurt',$9,$10)
  ```
- `routes/bookings.js:138–154` — i SAMME transaksjon skrives en `inntekt`-post til
  `regnskap_poster` (konto 3000, utgående MVA via `mvaSplitt`, jf. `lib/regnskap.js:19`).

Med andre ord: idet en kunde bare SPØR om en tid (forespurt), bokføres beløpet som
salgsinntekt med utgående MVA.

Statusoverganger skjer i `routes/bookings.js:253–299` (`PATCH /:id`). Den ruten
oppdaterer kun `bookings.status` (`routes/bookings.js:268`) og varsler kunden. Den
rører ALDRI `regnskap_poster`. Gyldige statuser er
`['forespurt','bekreftet','avlyst','fullfort']` (`routes/bookings.js:15`, speilet i
`db/schema.sql:43`).

Konsekvensen: blir en forespurt booking avlyst, står inntektsposten igjen. Det finnes
ingen kodesti som reverserer den. (Den eneste reverserende posten i systemet i dag er
refusjonsruten, dok 1 — men den kjøres bare hvis en ansatt aktivt trykker "refunder",
ikke ved en vanlig avlysning.)

## Konsekvens

Omsetning og utgående MVA overrapporteres. Hver forespørsel som aldri blir til et
faktisk oppmøte — feil dato, kunden ombestemmer seg, dobbel-forespørsel — teller som
salg i regnskapet. Skatteetaten får for høy utgående MVA og for høy omsetning. Tallene
ser bedre ut enn virkeligheten, og MVA-oppgjøret blir for høyt (eieren betaler MVA på
salg som aldri skjedde).

## Foreslått løsning

To ærlig vurderte alternativer.

### Alternativ (a): Flytt speilingen fra `forespurt` → `bekreftet`

Ikke bokfør ved opprettelse. Bokfør inntektsposten først når en ansatt setter status
til `bekreftet` i `PATCH /:id`.

- For: Regnskapet inneholder da bare bookinger som faktisk er bekreftet av firmaet.
  En forespørsel som aldri bekreftes bokføres aldri — ingen reversering nødvendig,
  ingen negativ post å rydde.
- Mot: Krever at inntektsposten flyttes fra booking-opprettelsen inn i status-PATCH,
  med samme idempotens-lookup som finnes i dag (`routes/bookings.js:128–132`) slik at
  gjentatte `bekreftet`-PATCH-er ikke dobbeltposterer. Status-PATCH må da også pakkes
  i `db.withTransaction` (den er i dag ikke transaksjonell — `routes/bookings.js:267`).
- Åpent: Skal `fullfort` uten forutgående `bekreftet` også utløse posten? (En booking
  kan i prinsippet settes rett til `fullfort`.) Da må trigger være "status ∈
  {bekreftet, fullfort} og ingen inntektspost finnes ennå".

### Alternativ (b): Behold speiling ved opprettelse, legg reverserende post ved avlysning

Behold dagens inntektspost på `forespurt`. Ved overgang til `avlyst` (og `ingen_oppmoete`
når den statusen finnes — se merknad under), legg en reverserende negativ post i SAMME
transaksjon som status-UPDATE-en.

- For: Minimal endring i booking-opprettelsen. Speiler mønsteret refusjonsruten
  allerede bruker (`routes/bookings.js:342–357`).
- Mot: Regnskapet inneholder da BÅDE en pluss- og en minuspost for hver avlyst
  forespørsel. Netto null, men det blåser opp bilagsmengden og gjør MVA-oppgjøret mer
  støyete. Og hver ny reverserings-sti er en ny mulig idempotens-defekt (samme klasse
  bug som dok 1) — status-PATCH må da også bli transaksjonell og idempotent, ellers
  kan to raske avlysnings-klikk gi to negative poster.

### Anbefaling: Alternativ (a)

Å ikke bokføre inntekt før firmaet har bekreftet handelen er både regnskapsmessig
riktigere (inntekten er ikke opptjent på forespørsels-tidspunktet) og gir færre
poster og færre reverserings-stier å vedlikeholde. Alternativ (b) løser symptomet ved
å stable en ny reverseringssti (med egen idempotens-risiko) oppå problemet;
alternativ (a) fjerner problemet ved kilden.

Merknad: en annen agent legger nå inn statusen `ingen_oppmoete`. Med alternativ (a)
er den irrelevant for MVA (inntekt bokføres uansett bare ved `bekreftet`). Med
alternativ (b) må `ingen_oppmoete` også utløse reversering. Enda et argument for (a).

## Datamigrering for historiske rader

Uansett alternativ finnes det trolig allerede feilbokførte inntektsposter i
produksjon: alle forespurte bookinger som ble avlyst etter at speilingen ble innført.

- Finn dem: inntektsposter (`kilde='booking'`, positiv `netto_ore`) hvis booking nå
  har status `avlyst` (og senere `ingen_oppmoete`) og ingen matchende negativ post
  finnes.
- Rett dem: legg en reverserende KREDITNOTA (negativ post med referanse til
  original-posten), IKKE slett den opprinnelige raden. Sletting bryter revisjonssporet
  og norsk bokføringslov (bokførte poster skal ikke fjernes, bare korrigeres). Dette
  er en engangs-backfill, kjøres etter at koden er landet, som eget script under
  `scripts/` og gjennomgått separat.
- Antall bør telles først:
  ```sql
  SELECT count(*) FROM regnskap_poster p
  JOIN bookings b ON b.id = p.booking_id
  WHERE p.kilde='booking' AND p.netto_ore > 0
    AND b.status IN ('avlyst')  -- utvid med 'ingen_oppmoete' når den finnes
    AND NOT EXISTS (
      SELECT 1 FROM regnskap_poster r
      WHERE r.booking_id = p.booking_id AND r.netto_ore < 0
    );
  ```
  Er tallet 0, trengs ingen backfill. Kjør denne før noe annet.

## Risiko + rollback

- Risiko: middels. Endrer NÅR inntekt bokføres — et regnskaps-tidspunkt eieren og
  ev. regnskapsfører må være innforstått med. Ingen endring i beløp eller MVA-sats,
  bare tidspunkt/betingelse.
- Rollback: revert av PR-en. Alternativ (a) har en subtilitet: bookinger opprettet
  MENS (a) var aktivt har ingen inntektspost før de bekreftes. Reverter man tilbake
  til "bokfør ved opprettelse", får ikke disse bookingene automatisk en post med
  mindre de re-bekreftes. Rollback bør derfor ledsages av en sjekk på om det finnes
  bekreftede bookinger uten inntektspost. Behold backfill-scriptet tilgjengelig.
- All endring bak gjennomgang av regnskapsfører før land (dette er skatterelevant).

## Test-plan

Bygg på `tests/routes/bookings.test.js` (samme stub-mønster).

Alternativ (a):
1. POST /api/bookings (status forespurt): forvent 201 og INGEN inntektspost
   (`state.regnskap` tom).
2. PATCH /:id → `bekreftet`: forvent at nøyaktig én inntektspost skrives, med
   aktivitetens `mva_sats` (gjenbruk assert fra `tests/routes/bookings.test.js:198–202`).
3. PATCH /:id → `bekreftet` en gang til: idempotent, ingen andre post.
4. PATCH /:id → `avlyst` (uten forutgående bekreftelse): ingen post, ingen reversering.

Alternativ (b), hvis valgt i stedet:
1. POST: inntektspost skrives (som i dag).
2. PATCH → `avlyst`: nøyaktig én negativ post, i samme tx som status-UPDATE.
3. PATCH → `avlyst` to ganger raskt: fortsatt bare én negativ post (idempotens).

Manuell verifikasjon mot staging Postgres: en full livssyklus forespurt →
bekreftet → avlyst, og kontroller at `SUM(netto_ore)` for bookingen er 0 (b) eller
korrekt (a) etterpå.

## Hva eieren må gjøre

- Velge alternativ (a) eller (b) sammen med regnskapsfører — dette er et
  regnskapsprinsipp-valg, ikke bare teknikk.
- Bekrefte at inntekt regnskapsmessig først er opptjent ved bekreftelse (støtter a).
- Godkjenne at et engangs backfill-script kjøres mot produksjon for historiske
  feilposter (etter telling).

## Åpne spørsmål

1. Hvor mange feilbokførte poster finnes allerede? (Telle-spørringen over.)
2. Skal `fullfort` uten `bekreftet` også trigge inntektsposten (alternativ a)?
3. Når `ingen_oppmoete` er innført: teller den som "ikke opptjent" (a: ingen post
   uansett) — bekreftes med regnskapsfører.
4. Er det ønskelig at status-PATCH blir transaksjonell uansett? Begge alternativer
   drar nytte av det; i dag er den ikke det (`routes/bookings.js:267`).
