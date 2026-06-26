# GDPR — personvern i Havstund-plattformen

Oversikt over personopplysninger (PII) systemet behandler, hvor de ligger, og
hvordan innsyn/sletting handteres. Dokumentet er en arbeidsreferanse for
drift — ikke en juridisk personvernerklaering.

Behandlingsansvarlig: Havstund (Ballstad, Lofoten).

---

## 1. PII-oversikt — hvor person­data ligger

Kilde: `db/schema.sql`. Kolonner som er person­data er markert.

| Tabell | PII-kolonner | Formal | Merknad |
|---|---|---|---|
| `users` | `navn`, `epost`, `passord_hash`, `totp_secret` | Konto/innlogging | Passord kun som bcrypt-hash. `anonymized_at` settes ved sletting. |
| `bookings` | `navn`, `epost`, `tlf`, `melding` | Booking (ogsa gjester uten konto) | `bruker_id` NULL for gjest. |
| `chat_threads` | `navn`, `epost` | Live chat-identifikasjon | `bruker_id` kobler til konto om innlogget. |
| `chat_messages` | `tekst` (fritekst kan inneholde PII) | Chat-historikk | Knyttet til thread. |
| `customer_messages` | `tekst` (fritekst) | Kunde↔studio-meldinger | Koblet til `bruker_id`. |
| `projects` | `tittel`, `beskrivelse` (fritekst) | Kundeprosjekter | Koblet til `bruker_id`. |
| `project_media` | `url`, `tittel` | Prosjektbilder | Kan vise identifiserbare personer. |
| `receipts` | `beskrivelse`, `belop` | Kvitteringer | Koblet til `bruker_id`. |
| `regnskap_poster` | `kontakt`, `beskrivelse`, `vedlegg` | Bokforing | Vedlegg = kvitteringsbilde (base64). Se oppbevaringsplikt. |
| `ansatte` | `navn`, `epost`, `stilling`, `timelonn_ore` | Lonn/ansatte | Koblet valgfritt til `user_id`. |
| `timeforinger` | `notat`, `aktivitet` | Timeforing | Koblet til ansatt. |
| `finance_scenarios` | `data` (JSONB) | Okonomiscenarier | Kan inneholde navngitte data. |
| `audit_log` | `actor_navn`, `detaljer` | Revisjonsspor | Ansvarlighet — se sletteunntak. |
| `reset_tokens` | (kobler `user_id`) | Passord-reset | Engangs, utloper. |
| `pageviews` | `anon_id`, `referrer`, `sti` | Analyse | Pseudonymt; ingen direkte identifikator. |

Indirekte: serverlogger (pino) og Sentry kan inneholde IP/e-post i feilspor —
behandle med samme varsomhet og kort retention.

---

## 2. Registrertes rettigheter

### Innsyn (rett til kopi)
Eksporter alt knyttet til en bruker via `bruker_id` + matchende `epost` for
gjeste-bookinger. Det finnes eksportrute i plattformen (`routes/export.js`);
bruk den for a samle brukerens data i ett svar. For gjester uten konto: sok pa
`epost` i `bookings` og `chat_threads`.

### Retting
Brukeren kan selv oppdatere konto via `public/konto.html`. Admin kan rette
felt direkte. Logg endringen i `audit_log`.

### Sletting / "rett til a bli glemt"
Plattformen bruker **anonymisering**, ikke hard DELETE, fordi enkelte data har
lovpalagt oppbevaring (regnskap).

---

## 3. Sletteprosess (anonymisering)

Mal: fjerne koblingen mellom person og data der det er lov, og beholde det som
loven krever (bokforing) i anonymisert/pseudonymisert form.

1. **Bekreft identitet** pa den som ber om sletting (epost-eier).
2. **Anonymiser `users`-raden** — behold raden (fremmednokler peker hit), men
   nullstill PII:
   - `navn` -> `'Slettet bruker'`
   - `epost` -> en ikke-reversibel placeholder, f.eks. `deleted+<id>@havstund.invalid`
     (ma vaere unik pga. UNIQUE-constraint)
   - `passord_hash` -> tilfeldig/ugyldig verdi (sperrer innlogging)
   - `totp_secret` -> `NULL`, `totp_enabled` -> `false`
   - `anonymized_at` -> `now()`
3. **Anonymiser frie person­felt** i koblede tabeller for samme `bruker_id`:
   - `bookings`: `navn`/`epost`/`tlf`/`melding`
   - `chat_threads`: `navn`/`epost`; vurder `chat_messages.tekst`
   - `customer_messages.tekst`, `projects.beskrivelse`, `project_media`
4. **Gjeste-bookinger** (uten `bruker_id`): finn pa `epost`, anonymiser samme
   felt.
5. **Behold for bokforingsplikt:** `regnskap_poster` og tilhorende `receipts`
   beholdes (norsk bokforingslov, normalt 5 ar). Erstatt fritt navn i
   `kontakt`/`beskrivelse` med en pseudonym referanse hvis mulig, men ikke slett
   selve posten/belopet.
6. **`audit_log` beholdes** som revisjonsspor (ansvarlighet, art. 5(2)). Ikke
   slett — det er nettopp sporet pa at sletting ble utfort.
7. **Logg slettingen** i `audit_log` (handling `gdpr_anonymisering`, hvem +
   nar + bruker_id).

> Idempotent: sjekk `anonymized_at IS NULL` for du kjorer, sa en gjentatt
> forespørsel ikke gjor skade.

### Backuper
Eldre backuper kan fortsatt inneholde person­data inntil de roterer ut. Sett
backup-retention (`docs/BACKUP-RESTORE.md`) sa data ikke beholdes lenger i
backup enn nodvendig. Ved konkret sletteforespørsel: noter at full fjerning
skjer nar backupene eldre enn anonymiseringsdatoen er pruned.

---

## 4. Oppbevaring (retention)

| Datatype | Oppbevaring | Grunnlag |
|---|---|---|
| Konto (`users`) | Til sletting/anonymisering | Samtykke/avtale |
| Bookinger (ikke-regnskapsdel) | Inntil anonymisering | Avtale |
| Regnskap (`regnskap_poster`, `receipts`) | ~5 ar | Bokforingsloven |
| Chat / kundemeldinger | Los, anonymiser ved sletteforespørsel | Avtale |
| `pageviews` | Kort (pseudonymt) | Berettiget interesse |
| `audit_log` | Behold | Ansvarlighet |
| Backuper | = `BACKUP_RETENTION` | Driftssikkerhet |

---

## 5. Sikkerhetstiltak (kort)

- Passord: bcrypt-hash, aldri klartekst.
- MFA: TOTP tilgjengelig (`totp_secret`/`totp_enabled`).
- Tilgang: rollebasert (`kunde`/`ansatt`/`admin`) via `lib/auth.js`.
- Token i httpOnly-cookie (`havstund_token`); secure cookies i `production`.
- Revisjon: admin-/ansatt-handlinger logges i `audit_log`.
- Backuper inneholder PII — oppbevares kryptert/tilgangsstyrt
  (`docs/BACKUP-RESTORE.md`).

---

*Sist oppdatert ved Fase 1–3-arbeidet. Hold tabellen i del 1 i synk med
`db/schema.sql` nar nye PII-kolonner legges til.*
