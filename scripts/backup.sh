#!/usr/bin/env bash
#
# Havstund — databasebackup
# ---------------------------------------------------------------------------
# Tar en tidsstemplet, gzippet pg_dump av DATABASE_URL og rydder gamle
# backuper etter en enkel retention-policy. Tenkt kjort som cron-jobb
# (f.eks. nattlig) pa en server med psql/pg_dump installert.
#
# Bruk:
#   ./scripts/backup.sh
#
# Miljovariabler:
#   DATABASE_URL      (pakrevd) Postgres-tilkoblingsstreng. Settes av Railway.
#   BACKUP_DIR        (valgfri) mappe backuper legges i. Default: ./backups
#   BACKUP_RETENTION  (valgfri) antall dager backuper beholdes. Default: 14
#   PGDUMP            (valgfri) sti til pg_dump-binaeren. Default: pg_dump
#
# Exit-koder:
#   0  ok
#   1  manglende DATABASE_URL
#   2  pg_dump ikke funnet
#   3  pg_dump feilet (delvis fil ryddes vekk)
#
# MERK: shell-script — ingen vitest-dekning (noteres i rapporten).
# ---------------------------------------------------------------------------
set -euo pipefail

# --- konfig -----------------------------------------------------------------
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETENTION="${BACKUP_RETENTION:-14}"
PGDUMP="${PGDUMP:-pg_dump}"

log() { printf '[backup] %s\n' "$*" >&2; }

# --- forhandskrav -----------------------------------------------------------
if [ -z "${DATABASE_URL:-}" ]; then
  log "FEIL: DATABASE_URL er ikke satt. Avbryter."
  exit 1
fi

if ! command -v "$PGDUMP" >/dev/null 2>&1; then
  log "FEIL: fant ikke '$PGDUMP'. Installer PostgreSQL-klienten (pg_dump). Avbryter."
  exit 2
fi

# --- ta backup --------------------------------------------------------------
mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTFILE="${BACKUP_DIR}/havstund-${TIMESTAMP}.sql.gz"

log "Starter pg_dump -> ${OUTFILE}"

# --no-owner / --no-acl gjor dumpen lett a restaurere til en ny Railway-db
# med et annet eier-/rollenavn. gzip strommes for a unnga stor mellomfil.
if "$PGDUMP" --no-owner --no-acl "$DATABASE_URL" | gzip -c > "$OUTFILE"; then
  SIZE="$(wc -c < "$OUTFILE" | tr -d ' ')"
  log "OK: backup skrevet (${SIZE} bytes)."
else
  log "FEIL: pg_dump feilet. Fjerner ufullstendig fil."
  rm -f "$OUTFILE"
  exit 3
fi

# --- retention-prune --------------------------------------------------------
# Slett backuper eldre enn BACKUP_RETENTION dager. Rorer kun vare egne filer
# (havstund-*.sql.gz) i BACKUP_DIR — aldri noe annet.
log "Rydder backuper eldre enn ${BACKUP_RETENTION} dager i ${BACKUP_DIR}"
DELETED=0
while IFS= read -r -d '' old; do
  rm -f "$old"
  log "  slettet gammel backup: $old"
  DELETED=$((DELETED + 1))
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'havstund-*.sql.gz' \
           -mtime "+${BACKUP_RETENTION}" -print0 2>/dev/null)

log "Ferdig. ${DELETED} gammel(e) backup(er) ryddet."
exit 0
