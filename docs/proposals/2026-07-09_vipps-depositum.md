# Forslag: Vipps-depositum (online betaling)

- Status: foreslått — IKKE klar for bygging (blokkert, se under)
- Dato: 2026-07-09
- Berører penger: JA (faktiske innbetalinger fra kunder)
- Reviewer: Karri
- Filer i dag: ingen betalingskode finnes; kundeløfte i `public/js/site.js:29`

---

## Problem (med fil:linje-bevis)

To ting er sanne samtidig:

1. Det finnes INGEN betalingsintegrasjon i repoet. Verifisert:
   `grep -rniE 'vipps|stripe|gavekort|acuity'` over `public routes lib integrations db`
   gir kun treff i `public/js/site.js:29` (kundeteksten under) og urelaterte
   CSS/marquee-treff. Ingen Vipps-SDK, ingen webhook-rute, ingen betalings-tabell,
   ingen env-hemmelighet for betaling i `.env.example`.

2. Nettsiden lover kundene LIVE at online betaling kommer. `public/js/site.js:29`:
   ```
   modalText.textContent = 'Online booking kommer (Acuity + Vipps). Send oss en
   forespørsel i mellomtiden, så svarer vi raskt.';
   ```
   Dette er et utestående produktløfte til ekte kunder.

Kontekst: en annen agent mykgjør akkurat nå denne teksten (fjerner det konkrete
"Vipps"-løftet mot noe mindre forpliktende). Dette forslaget handler ikke om teksten,
men om den faktiske funksjonen bak løftet.

## Konsekvens

Dette dokumentet konkluderer klart: Vipps-depositum KAN IKKE BYGGES ENNÅ. Å ta imot
ekte penger nå, med systemets nåværende svakheter, ville flytte reell finansiell
risiko over på kunden og eieren. Begrunnelse under.

## Hvorfor det er blokkert (tre uavhengige blokkere)

1. Merchant-avtale er eierens arbeid, ikke en agents. Vipps krever merchant-avtale,
   PSD2-godkjenning, aksepterte vilkår og en merchant-ID/klientnøkkel. Ingen agent
   kan skaffe disse. Uten dem finnes det ingenting å integrere mot.

2. Beslutningen bør bygge på data vi ikke har ennå. Depositum løser ett problem:
   kunder som ikke møter opp (no-show). Men vi kan ikke måle hvor stort det problemet
   er i dag, fordi no-show i dag registreres som `avlyst` — samme status som en
   ordinær avlysning (`routes/bookings.js:15` — statuslisten har ingen egen no-show-
   verdi). En annen agent legger nå inn statusen `ingen_oppmoete`. FØRST når den er
   på plass kan vi telle faktiske no-shows. Anbefaling: mål i 4–8 uker etter at
   `ingen_oppmoete` er live, og la tallet avgjøre om depositum i det hele tatt er verdt
   kompleksiteten. Er no-show-raten lav, er hele funksjonen unødvendig risiko.

3. Refusjonsstien er ikke idempotent i dag (se dok
   `2026-07-09_refusjon-idempotens-atomisitet.md`). `routes/bookings.js:303–374`
   mangler transaksjon, rad-lås og dobbelt-vern. Å ta imot innbetalinger oppå en
   refusjonssti som kan kjøre to ganger betyr at et depositum kan refunderes to ganger
   — nå med ekte penger, ikke bare regnskapsposter. Dok 1 MÅ være landet og verifisert
   før én linje betalingskode skrives.

## Foreslått løsning (teknisk skisse — klar til bruk NÅR blokkerne er løst)

Dette er en skisse, ikke en byggeordre. Den finnes så eieren og reviewer kan vurdere
omfanget og skaffe det som trengs.

### Datamodell

```sql
CREATE TABLE IF NOT EXISTS betalinger (
  id                SERIAL PRIMARY KEY,
  booking_id        INTEGER NOT NULL REFERENCES bookings(id),
  idempotens_nokkel TEXT NOT NULL UNIQUE,   -- generert av OSS per betalingsforsøk
  belop_ore         INTEGER NOT NULL,       -- forventet beløp, satt av server
  status            TEXT NOT NULL DEFAULT 'opprettet',
                    -- 'opprettet'|'autorisert'|'fanget'|'avbrutt'|'refundert'|'delvis_refundert'
  vipps_ref         TEXT,                   -- ordre-/betalings-ref fra Vipps
  refundert_ore     INTEGER NOT NULL DEFAULT 0,
  opprettet         TIMESTAMPTZ DEFAULT now(),
  oppdatert         TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_betaling_vipps_ref
  ON betalinger (vipps_ref) WHERE vipps_ref IS NOT NULL;
```

Prinsipper (alle speiler læringen fra dok 1):

- Idempotens-nøkkel per betaling: server genererer en unik nøkkel per
  betalingsforsøk (UNIQUE-kolonnen). Sendes til Vipps. Et gjentatt forsøk med samme
  nøkkel gir samme betaling, ikke en ny — beskytter mot dobbel-submit.
- Webhook-signaturverifisering: Vipps' callback MÅ verifiseres kryptografisk
  (signatur/HMAC mot vår webhook-hemmelighet) FØR den endrer betalingsstatus. En
  uverifisert webhook er en åpen dør for å forfalske "betalt".
- Stol ALDRI på klienten for beløp. `belop_ore` settes server-side fra
  aktivitetens pris (`activities.pris` × antall — samme kilde som
  `routes/bookings.js:80`). Klienten sender aldri beløpet; den sender bare
  hvilken booking/aktivitet. Ellers kan en kunde betale 1 kr for en tur til 2000.
- Betalingsstatus-oppdateringer i transaksjon (samme mønster som
  `routes/bookings.js:84`): les betalingsrad `FOR UPDATE`, sjekk at overgangen er
  lovlig, skriv ny status + speil regnskapspost i SAMME tx. Aldri svelg feil.
- Delvis refusjon av depositum: `refundert_ore` akkumuleres; hver refusjon avviser
  hvis `refundert_ore + ny > belop_ore`. Dette er nettopp designet dok 1 flagger som
  et åpent spørsmål (én vs. flere refusjoner) — depositum tvinger frem flere delvise
  refusjoner, så refusjonsstien må redesignes for det FØR depositum bygges.

### Env-hemmeligheter som trengs (må inn i Railway, ikke i repo)

- `VIPPS_CLIENT_ID`
- `VIPPS_CLIENT_SECRET`
- `VIPPS_SUBSCRIPTION_KEY` (Ocp-Apim-Subscription-Key)
- `VIPPS_MERCHANT_SERIAL_NUMBER` (MSN)
- `VIPPS_WEBHOOK_SECRET` (til signaturverifisering)
- Separate test- vs. produksjonsnøkler.

## Alternativer vurdert

- Acuity/tredjeparts bookingsystem med innebygd betaling (som teksten nevner).
  Forkastet som antakelse, ikke beslutning: flytter no-show-data og kundeforhold ut
  av eierens eget system. Bør vurderes eksplisitt mot egen integrasjon, men ikke uten
  no-show-data (blokker 2).
- Vipps eller Stripe. Stripe er teknisk enklere, men norske kunder forventer Vipps og
  teksten lover Vipps. Valget er forretningsmessig, ikke teknisk — eierens beslutning.
- Full forhåndsbetaling vs. kun depositum. Depositum (delbeløp) er mildere mot kunden
  og nok til å dempe no-show. Men delbeløp krever nettopp den delvis-refusjons-logikken
  som er mest risikabel. Full betaling er teknisk enklere. Avhenger av forretningsvalg.

## Risiko + rollback

- Dette er den mest risikable funksjonen i katalogen: den flytter ekte penger.
- Rollback av selve integrasjonen: bak en env-brytende feature-flag (f.eks.
  `BETALING_ENABLED`), av som standard, så hele funksjonen kan slås av uten deploy.
- Ingen kode bør skrives før sjekklisten under er grønn.

## Hva eieren må gjøre (sjekkliste — alt før én linje kode)

1. [ ] Inngå Vipps merchant-avtale, fullføre PSD2/KYC, akseptere vilkår.
2. [ ] Skaffe merchant-ID (MSN) + API-nøkler for BÅDE test og produksjon.
3. [ ] Bestemme forretningsmodell: depositum (delbeløp) vs. full betaling; beløp/sats.
4. [ ] Avklare refusjonspolicy: når, hvor mye, hvem kan utløse.
5. [ ] Vente på at `ingen_oppmoete`-statusen er live, så måle no-show i 4–8 uker.
6. [ ] Beslutte, basert på no-show-tallet, om depositum faktisk trengs.
7. [ ] Bekrefte at dok 1 (refusjons-idempotens) er landet og verifisert.
8. [ ] Legge alle Vipps-hemmeligheter i Railway env (ikke i repoet).
9. [ ] Avklare med regnskapsfører hvordan mottatt depositum bokføres (forskudd/gjeld
   vs. inntekt ved oppmøte — samme prinsipp-spørsmål som gavekort, dok 4).

## Åpne spørsmål

1. Hvor høy er faktisk no-show-rate? (Umålbart før `ingen_oppmoete` + 4–8 uker.)
2. Depositum eller full betaling? Beløp?
3. Bokføres mottatt depositum som forskudd (gjeld) til oppmøtet, eller som inntekt
   ved innbetaling? Feil svar her gjentar MVA-defekten fra dok 2.
4. Hva skjer med depositum ved legitim avlysning fra kundens side vs. no-show? Ulik
   refusjonspolicy?
