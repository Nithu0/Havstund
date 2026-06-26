# Backup & restore — Havstund

Runbook for sikkerhetskopiering og gjenoppretting av Havstund-databasen
(PostgreSQL). All forretningsdata bor i én Postgres-database referert av
`DATABASE_URL`. Tar du backup av den, har du backup av alt.

---

## 1. Hva som sikres

Hele databasen via `pg_dump` — alle tabeller i `db/schema.sql`:
brukere, bookinger, aktiviteter, chat, prosjekter, kvitteringer, regnskap,
ansatte/timer, audit-log m.m. Appen kjorer selv `db/schema.sql` ved oppstart,
sa en restore trenger ikke kjore skjema manuelt.

**Ikke** dekket av db-backup: filer pa Railways flyktige filsystem. Vedlegg
(kvitteringsbilder) lagres som base64 i databasen nettopp derfor, og er dermed
med i dumpen.

---

## 2. Ta en backup

```bash
DATABASE_URL='postgres://...' ./scripts/backup.sh
```

Resultat: `./backups/havstund-YYYYMMDD-HHMMSS.sql.gz` (gzippet `pg_dump`).

Miljovariabler:

| Variabel | Default | Forklaring |
|---|---|---|
| `DATABASE_URL` | — (pakrevd) | Postgres-tilkoblingsstreng. |
| `BACKUP_DIR` | `./backups` | Hvor backupene legges. |
| `BACKUP_RETENTION` | `14` | Behold backuper sa mange dager; eldre slettes. |
| `PGDUMP` | `pg_dump` | Sti til `pg_dump` om den ikke er pa `PATH`. |

Skriptet rydder selv vekk backuper eldre enn `BACKUP_RETENTION` dager (kun
sine egne `havstund-*.sql.gz`-filer).

### Planlagt (cron)

Nattlig backup kl 03:00, behold 30 dager, til `/var/backups/havstund`:

```cron
0 3 * * *  DATABASE_URL='postgres://...' BACKUP_DIR='/var/backups/havstund' BACKUP_RETENTION=30 /sti/til/repo/scripts/backup.sh >> /var/log/havstund-backup.log 2>&1
```

Kjorer du i Railway: bruk en separat cron-/worker-tjeneste med samme
`DATABASE_URL`-referanse, eller ta backup fra en driftsmaskin som har
nettverkstilgang til Postgres.

---

## 3. Restore (gjenoppretting)

> ADVARSEL: en restore overskriver data i mal-databasen. Restaurer alltid til
> en **tom / ny** database forst, verifiser, og bytt sa over.

1. Pakk ut dumpen:

   ```bash
   gunzip -k backups/havstund-YYYYMMDD-HHMMSS.sql.gz
   ```

2. Restaurer til en mal-database (her en ny, tom db):

   ```bash
   psql "$TARGET_DATABASE_URL" < backups/havstund-YYYYMMDD-HHMMSS.sql
   ```

   Dumpen er tatt med `--no-owner --no-acl`, sa eier-/rollenavn i mal-dben
   trenger ikke matche kilden.

3. Pek appen mot den gjenopprettede databasen (`DATABASE_URL`) og start.
   Appen kjorer `db/schema.sql` idempotent ved oppstart — ingen manuelle
   migrasjoner.

### Punkt-i-tid / katastrofe

- Siste nattlige dump er gjenopprettingspunktet (RPO = inntil 24t med daglig
  cron). Vil du ha lavere RPO: kjor `backup.sh` oftere, eller bruk Railways
  managed Postgres-backup/PITR i tillegg.
- Test restore jevnlig (f.eks. kvartalsvis) mot en throwaway-database — en
  backup du aldri har restaurert er en antakelse, ikke en backup.

---

## 4. Oppbevaring & sikkerhet

- Backupene inneholder personopplysninger (se `docs/GDPR.md`). Oppbevar dem
  kryptert / med tilgangskontroll, ikke i et apent repo eller offentlig bucket.
- `backups/` bor IKKE sjekkes inn i git. Legg `backups/` i `.gitignore` om du
  kjorer skriptet med default `BACKUP_DIR`.
- Retention pa backuper bor folge sletteplikten i GDPR-dokumentet — ikke
  behold person­data lenger i backup enn i drift uten grunn.
