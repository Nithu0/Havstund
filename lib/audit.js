/* Havstund — revisjonsspor (audit log).
   Skriver admin-/ansatt-handlinger til audit_log for GDPR-ansvarlighet.
   Fire-and-forget: en feil her skal ALDRI stoppe den egentlige handlingen,
   så writeAudit svelger alle feil (kaster aldri) og returnerer { ok: bool }.

   audit_log-kolonner (db/schema.sql):
     actor_id   INTEGER   — bruker-id (token.id)
     actor_navn TEXT      — bruker-navn (token.navn)
     handling   TEXT      — kort kode, f.eks. 'booking.refund'
     detaljer   JSONB     — vilkårlig kontekst-objekt */
const db = require('../db');

// actor: token-objektet { id, navn, rolle } (eller null for system-handlinger).
// handling: kort streng. detaljer: objekt (lagres som JSONB).
async function writeAudit(actor, handling, detaljer) {
  try {
    if (!db.isConfigured()) return { ok: false, grunn: 'db-av' };
    const actorId = actor && actor.id != null ? actor.id : null;
    const actorNavn = actor && actor.navn != null ? String(actor.navn) : null;
    await db.query(
      'INSERT INTO audit_log (actor_id, actor_navn, handling, detaljer) VALUES ($1, $2, $3, $4)',
      [actorId, actorNavn, String(handling || ''), JSON.stringify(detaljer == null ? {} : detaljer)]
    );
    return { ok: true };
  } catch (e) {
    console.error('audit-skriving feilet:', e && e.message);
    return { ok: false, grunn: 'feil' };
  }
}

module.exports = { writeAudit };
